import { afterAll, describe, expect, it } from 'vitest';
import {
  createEmptyNetworkConfig,
  type Design,
  type NodeInstance,
  type ScriptAsset,
} from '@infrasim/shared-types';
import { executeInSandbox, stopSandboxBundler } from '../index.js';

afterAll(async () => {
  await stopSandboxBundler();
});

function makeScript(source: string, timeoutMs = 15000): ScriptAsset {
  return {
    id: 'script-sdk-test',
    name: 'handler.ts',
    kind: 'handler',
    language: 'typescript',
    entry: 'handler',
    source,
    memoryMb: 128,
    timeoutMs,
    env: {},
  };
}

function makeNode(
  id: string,
  serviceId: string,
  label: string,
  configOverrides: Partial<NodeInstance['config']> = {},
): NodeInstance {
  return {
    id,
    serviceId,
    label,
    position: { x: 0, y: 0 },
    region: 'us-east-1',
    config: {
      instances: 1,
      latency: { distribution: 'fixed', p50: 25, p95: 25 },
      operations: {},
      ...configOverrides,
    },
  };
}

function makeDesign(nodes: NodeInstance[], edges: Design['edges']): Design {
  return {
    schemaVersion: 1,
    id: 'd-sdk',
    name: 'SDK Shim Design',
    nodes,
    edges,
    groups: [],
    network: createEmptyNetworkConfig(),
    scenarios: [],
    scripts: [],
    fixtures: [],
    settings: {
      seed: 42,
      currency: 'USD',
      includeFreeTier: false,
    },
  };
}

describe('T3.4 Drop-in AWS, GCP, Azure, and OCI SDK shims', () => {
  it('runs pasted AWS SDK v3 S3Client + GetObjectCommand code unmodified (Acceptance #5)', async () => {
    const fn = makeNode('fn1', 'aws.lambda', 'Worker');
    const s3 = makeNode('s3', 'aws.s3', 'AssetsBucket', {
      operations: {
        GetObject: {
          responseTemplate: JSON.stringify({
            Body: '{"hello":"world","count":3}',
            ETag: '"etag-mock-1"',
            ContentType: 'application/json',
          }),
          latency: { distribution: 'fixed', p50: 30, p95: 30 },
        },
      },
    });
    const design = makeDesign(
      [fn, s3],
      [{ id: 'e1', from: 'fn1', to: 's3', protocol: 'https', callType: 'sync', weight: 1 }],
    );

    const res = await executeInSandbox({
      script: makeScript(`
        import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
        const client = new S3Client({ region: 'us-east-1' });
        export async function handler(event: { key: string }) {
          const out = await client.send(new GetObjectCommand({ Bucket: 'assets', Key: event.key }));
          const text = await out.Body.transformToString();
          await client.send(new PutObjectCommand({ Bucket: 'assets', Key: 'copy.json', Body: text }));
          return {
            parsed: JSON.parse(text),
            etag: out.ETag,
            status: out.$metadata.httpStatusCode,
          };
        }
      `),
      event: { key: 'config.json' },
      design,
      node: fn,
    });

    expect(res.ok).toBe(true);
    expect(res.calls).toHaveLength(2);
    expect(res.calls[0]?.serviceId).toBe('aws.s3');
    expect(res.calls[0]?.op).toBe('GetObject');
    expect(res.calls[1]?.op).toBe('PutObject');
    expect(res.virtualDurationMs).toBe(55);
    expect(res.result).toEqual({
      parsed: { hello: 'world', count: 3 },
      etag: '"etag-mock-1"',
      status: 200,
    });
  });

  it('supports arbitrary @aws-sdk/client-* imports via dynamic CJS prototype proxy & DynamoDB DocumentClient', async () => {
    const res = await executeInSandbox({
      script: makeScript(`
        import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
        import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
        import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
        import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
        const sqs = new SQSClient({ region: 'us-east-1' });
        const polly = new PollyClient({ region: 'us-east-1' });

        export async function handler() {
          await ddb.send(new PutCommand({ TableName: 'users', Item: { id: 'u1' } }));
          const got = await ddb.send(new GetCommand({ TableName: 'users', Key: { id: 'u1' } }));
          const queried = await ddb.send(new QueryCommand({ TableName: 'users' }));
          const sent = await sqs.send(new SendMessageCommand({ QueueUrl: 'q', MessageBody: 'hi' }));
          const speech = await polly.send(new SynthesizeSpeechCommand({ Text: 'hello' }));
          return {
            hasItem: Boolean(got.Item?.id),
            queryCount: queried.Items?.length,
            msgId: sent.MessageId,
            pollyOk: speech.$metadata?.httpStatusCode === 200,
          };
        }
      `),
      seed: 77,
    });

    expect(res.ok).toBe(true);
    expect(res.calls).toHaveLength(5);
    expect(res.calls[4]?.serviceId).toBe('aws.polly');
    expect(res.calls[4]?.op).toBe('Synthesize');
    expect(res.result).toMatchObject({
      hasItem: true,
      queryCount: 5,
      pollyOk: true,
    });
  });

  it('supports AWS Bedrock Runtime commands including ConverseStream async iterator', async () => {
    const res = await executeInSandbox({
      script: makeScript(`
        import {
          BedrockRuntimeClient,
          InvokeModelCommand,
          ConverseCommand,
          ConverseStreamCommand,
        } from '@aws-sdk/client-bedrock-runtime';

        const br = new BedrockRuntimeClient({ region: 'us-east-1' });
        export async function handler() {
          const c1 = await br.send(new ConverseCommand({ modelId: 'anthropic.claude-3', messages: [] }));
          const c2 = await br.send(new InvokeModelCommand({
            modelId: 'anthropic.claude-3',
            body: JSON.stringify({ prompt: 'hi' }),
          }));
          const s = await br.send(new ConverseStreamCommand({ modelId: 'anthropic.claude-3', messages: [] }));
          const deltas = [];
          for await (const ev of s.stream) {
            if (ev.contentBlockDelta?.delta?.text) {
              deltas.push(ev.contentBlockDelta.delta.text);
            }
          }
          return {
            converseTextLen: (c1.output?.message?.content?.[0]?.text || '').length,
            invokeParsedId: JSON.parse(Buffer.from(c2.body).toString('utf8')).id,
            streamDeltas: deltas.length,
          };
        }
      `),
    });

    expect(res.ok).toBe(true);
    expect(res.calls).toHaveLength(3);
    expect(res.calls[2]?.streamed).toBe(true);
    const out = res.result as {
      converseTextLen: number;
      invokeParsedId: string;
      streamDeltas: number;
    };
    expect(out.converseTextLen).toBeGreaterThan(0);
    expect(out.invokeParsedId).toContain('resp-');
    expect(out.streamDeltas).toBeGreaterThan(0);
  });

  it('supports GCP Storage, PubSub, Firestore, Secret Manager, and Vertex AI SDKs', async () => {
    const res = await executeInSandbox({
      script: makeScript(`
        import { Storage } from '@google-cloud/storage';
        import { PubSub } from '@google-cloud/pubsub';
        import { Firestore } from '@google-cloud/firestore';
        import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
        import { VertexAI } from '@google-cloud/vertexai';

        export async function handler() {
          const [buf] = await new Storage().bucket('b').file('a.txt').download();
          const msgId = await new PubSub().topic('events').publishJSON({ ok: true });
          const doc = await new Firestore().collection('users').doc('u1').get();
          const [sec] = await new SecretManagerServiceClient().accessSecretVersion({ name: 'p/s/v/1' });
          const model = new VertexAI().getGenerativeModel({ model: 'gemini-2.5-flash' });
          const gen = await model.generateContent('hello');
          return {
            gcsBytes: buf.length,
            msgId: Boolean(msgId),
            docExists: doc.exists,
            hasDocId: Boolean(doc.data()?._id),
            secretStr: sec.payload.data.toString('utf8'),
            geminiText: gen.response.candidates[0].content.parts[0].text,
          };
        }
      `),
    });

    expect(res.ok).toBe(true);
    expect(res.calls).toHaveLength(5);
    const r = res.result as Record<string, unknown>;
    expect(r.gcsBytes).toBeGreaterThan(0);
    expect(r.msgId).toBe(true);
    expect(r.docExists).toBe(true);
    expect(r.hasDocId).toBe(true);
    expect(String(r.secretStr)).toContain('apiKey');
    expect(String(r.geminiText).length).toBeGreaterThan(0);
  });

  it('supports Azure Blob, Cosmos DB, Service Bus, Key Vault, and OpenAI / AzureOpenAI SDKs', async () => {
    const res = await executeInSandbox({
      script: makeScript(`
        import { BlobServiceClient } from '@azure/storage-blob';
        import { CosmosClient } from '@azure/cosmos';
        import { ServiceBusClient } from '@azure/service-bus';
        import { SecretClient } from '@azure/keyvault-secrets';
        import { AzureOpenAI } from 'openai';

        export async function handler() {
          const buf = await BlobServiceClient.fromConnectionString('mock')
            .getContainerClient('c')
            .getBlockBlobClient('f.json')
            .downloadToBuffer();
          const { resource } = await new CosmosClient({}).database('app').container('items').item('1', '1').read();
          const sb = new ServiceBusClient('mock');
          await sb.createSender('jobs').sendMessages({ body: 'work' });
          const secret = await new SecretClient('https://kv.vault.azure.net').getSecret('db-pass');
          const ai = new AzureOpenAI({ deployment: 'gpt-4o-mini' });
          const chat = await ai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
          return {
            blobLen: buf.length,
            cosmosHasId: Boolean(resource?._id),
            secretVal: secret.value,
            aiText: chat.choices[0].message.content,
            tokens: chat.usage.total_tokens,
          };
        }
      `),
    });

    expect(res.ok).toBe(true);
    expect(res.calls).toHaveLength(5);
    const r = res.result as Record<string, unknown>;
    expect(r.blobLen).toBeGreaterThan(0);
    expect(r.cosmosHasId).toBe(true);
    expect(String(r.secretVal)).toContain('apiKey');
    expect(String(r.aiText).length).toBeGreaterThan(0);
    expect(Number(r.tokens)).toBeGreaterThan(0);
  });

  it('supports OCI Common, Object Storage, Generative AI Inference, and Queue SDKs', async () => {
    const res = await executeInSandbox({
      script: makeScript(`
        import { SimpleAuthenticationDetailsProvider, Region } from 'oci-common';
        import { ObjectStorageClient } from 'oci-objectstorage';
        import { GenerativeAiInferenceClient } from 'oci-generativeaiinference';
        import { QueueClient } from 'oci-queue';

        export async function handler() {
          const auth = new SimpleAuthenticationDetailsProvider('t', 'u', 'f', 'k', null, Region.US_ASHBURN_1);
          const os = new ObjectStorageClient({ authenticationDetailsProvider: auth });
          const obj = await os.getObject({ namespaceName: 'ns', bucketName: 'b', objectName: 'a.txt' });
          const qc = new QueueClient({ authenticationDetailsProvider: auth });
          await qc.putMessages({ queueId: 'q1', putMessagesDetails: { messages: [{ content: 'hi' }] } });
          const gen = new GenerativeAiInferenceClient({ authenticationDetailsProvider: auth });
          const chat = await gen.chat({ chatDetails: { servingMode: { modelId: 'cohere.command-r-plus' } } });
          return {
            etag: obj.eTag,
            textLen: chat.chatResult.chatResponse.choices[0].message.content[0].text.length,
          };
        }
      `),
    });

    expect(res.ok).toBe(true);
    expect(res.calls).toHaveLength(3);
    expect(res.calls[0]?.serviceId).toBe('oci.object_storage');
    expect(res.calls[1]?.serviceId).toBe('oci.queue');
    expect(res.calls[2]?.serviceId).toBe('oci.genai');
    const r = res.result as { etag: string; textLen: number };
    expect(r.etag).toBeTruthy();
    expect(r.textLen).toBeGreaterThan(0);
  });

  it('records property paths through SDK shims during discoveryMode (S3 Body + DynamoDB Item)', async () => {
    const res = await executeInSandbox({
      script: makeScript(`
        import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
        import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
        import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

        const s3 = new S3Client({});
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
        export async function handler() {
          const s3Res = await s3.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
          const bodyText = await s3Res.Body.transformToString();
          const ddbRes = await ddb.send(new GetCommand({ TableName: 'users', Key: { id: '1' } }));
          return { bodyText, userId: String(ddbRes.Item.userId), total: Number(ddbRes.Item.total) };
        }
      `),
      discoveryMode: true,
    });

    expect(res.ok).toBe(true);
    expect(res.discoveredPaths?.['aws.s3::GetObject']).toContain('Body');
    const ddbPaths = res.discoveredPaths?.['aws.dynamodb::GetItem'] ?? [];
    expect(ddbPaths).toContain('Item.userId');
    expect(ddbPaths).toContain('Item.total');
  });
});
