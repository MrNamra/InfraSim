function normalizeAwsPkgServiceId(specifier: string): string {
  const short = specifier.slice('@aws-sdk/client-'.length).toLowerCase();
  const map: Record<string, string> = {
    s3: 'aws.s3',
    dynamodb: 'aws.dynamodb',
    sqs: 'aws.sqs',
    sns: 'aws.sns',
    eventbridge: 'aws.eventbridge',
    kinesis: 'aws.kinesis',
    firehose: 'aws.kinesis_firehose',
    'secrets-manager': 'aws.secrets_manager',
    secretsmanager: 'aws.secrets_manager',
    ssm: 'aws.ssm_parameter',
    'bedrock-runtime': 'aws.bedrock',
    'bedrock-agent-runtime': 'aws.bedrock_kb',
    'sagemaker-runtime': 'aws.sagemaker_endpoint',
    sagemaker: 'aws.sagemaker_endpoint',
    lambda: 'aws.lambda',
    kms: 'aws.kms',
    ses: 'aws.ses',
    'rds-data': 'aws.rds_postgres',
    stepfunctions: 'aws.stepfunctions_std',
    sfn: 'aws.stepfunctions_std',
    rekognition: 'aws.rekognition',
    textract: 'aws.textract',
    comprehend: 'aws.comprehend',
    transcribe: 'aws.transcribe',
    polly: 'aws.polly',
    translate: 'aws.translate',
    'lex-runtime-v2': 'aws.lex',
    lex: 'aws.lex',
    kendra: 'aws.kendra',
  };
  return map[short] ?? `aws.${short.replace(/-/g, '_')}`;
}

function buildAwsV3GenericCode(specifier: string): string {
  const canonicalSvc = normalizeAwsPkgServiceId(specifier);
  return `
const SERVICE_ID = ${JSON.stringify(canonicalSvc)};
const OP_ALIASES = {
  ListObjectsV2: 'ListObjects',
  SendMessage: 'Send',
  SendMessageBatch: 'Send',
  ReceiveMessage: 'Receive',
  DeleteMessage: 'Delete',
  GetSecretValue: 'GetSecret',
  GetParameter: 'GetParam',
  PutParameter: 'PutParam',
  Retrieve: 'Search',
  RetrieveAndGenerate: 'Search',
  StartExecution: 'Invoke',
  InvokeEndpoint: 'Invoke',
  SynthesizeSpeech: 'Synthesize',
  StartTranscriptionJob: 'Transcribe',
  SendEmail: 'Send',
  SendRawEmail: 'Send',
  DetectLabels: 'Classify',
  AnalyzeDocument: 'Extract',
  TranslateText: 'Translate',
};

function wrapBodyHelper(rawBody) {
  if (rawBody && typeof rawBody === 'object' && typeof rawBody.transformToString === 'function') {
    return rawBody;
  }
  const str = typeof rawBody === 'string'
    ? rawBody
    : (rawBody === undefined || rawBody === null ? '' : JSON.stringify(rawBody));
  const box = new String(str);
  Object.defineProperty(box, 'transformToString', {
    enumerable: false,
    value: async () => str,
  });
  Object.defineProperty(box, 'transformToByteArray', {
    enumerable: false,
    value: async () => new TextEncoder().encode(str),
  });
  Object.defineProperty(box, 'toJSON', {
    enumerable: false,
    value: () => str,
  });
  return box;
}

class AwsBaseCommand {
  constructor(input = {}) {
    this.input = input;
  }
}

class BaseClient {
  constructor(config = {}) {
    this.config = config;
  }
  async send(command) {
    const rawName = command?.__opName || command?.constructor?.name?.replace(/Command$/, '') || 'Call';
    const op = OP_ALIASES[rawName] || rawName;
    const rawOut = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'aws-v3',
      serviceId: SERVICE_ID,
      op,
      input: command?.input ?? {},
      region: this.config?.region,
    });
    if (rawOut && rawOut.__isDiscoveryProxy) {
      if (SERVICE_ID === 'aws.s3' && op === 'GetObject') {
        const bodyProxy = rawOut.Body;
        const wrappedBody = new Proxy(bodyProxy, {
          get(t, p) {
            if (p === 'transformToString') return async () => '{}';
            if (p === 'transformToByteArray') return async () => new Uint8Array();
            return Reflect.get(t, p);
          },
        });
        return new Proxy(rawOut, {
          get(t, p) {
            if (p === 'Body') return wrappedBody;
            return Reflect.get(t, p);
          },
        });
      }
      return rawOut;
    }
    const base = (rawOut && typeof rawOut === 'object' && !Array.isArray(rawOut))
      ? { ...rawOut }
      : { data: rawOut };
    if (SERVICE_ID === 'aws.s3' && op === 'GetObject' && 'Body' in base) {
      base.Body = wrapBodyHelper(base.Body);
    }
    if (!base.$metadata) {
      base.$metadata = { httpStatusCode: 200, requestId: globalThis.crypto.randomUUID() };
    }
    return base;
  }
  destroy() {}
}

function createCommandClass(opName) {
  const cls = class extends AwsBaseCommand {
    constructor(input = {}) {
      super(input);
      this.__opName = opName;
    }
  };
  Object.defineProperty(cls, 'name', { value: opName + 'Command' });
  return cls;
}

const commandCache = new Map();
const awsProxy = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop === 'symbol' || prop === '__esModule' || prop === 'default') {
      return undefined;
    }
    const name = String(prop);
    if (name.endsWith('Client')) {
      return BaseClient;
    }
    const opName = name.endsWith('Command') ? name.slice(0, -'Command'.length) : name;
    if (!commandCache.has(opName)) {
      commandCache.set(opName, createCommandClass(opName));
    }
    return commandCache.get(opName);
  },
});

module.exports = Object.create(awsProxy);
module.exports.BaseClient = BaseClient;
module.exports.S3Client = BaseClient;
module.exports.DynamoDBClient = BaseClient;
module.exports.SQSClient = BaseClient;
module.exports.SNSClient = BaseClient;
module.exports.EventBridgeClient = BaseClient;
module.exports.KinesisClient = BaseClient;
module.exports.SecretsManagerClient = BaseClient;
module.exports.SSMClient = BaseClient;
module.exports.LambdaClient = BaseClient;
module.exports.KMSClient = BaseClient;
module.exports.SESClient = BaseClient;
module.exports.SFNClient = BaseClient;
module.exports.BedrockAgentRuntimeClient = BaseClient;
module.exports.SageMakerRuntimeClient = BaseClient;
`;
}

const LIB_DYNAMODB_CODE = `
class DocCommand {
  constructor(input = {}, opName) {
    this.input = input;
    this.__opName = opName;
  }
}

export class DynamoDBDocumentClient {
  constructor(baseClient) {
    this.baseClient = baseClient;
  }
  static from(client) {
    return new DynamoDBDocumentClient(client);
  }
  async send(command) {
    const op = command?.__opName || 'GetItem';
    const rawOut = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'aws-ddb-doc',
      serviceId: 'aws.dynamodb',
      op,
      input: command?.input ?? {},
      region: this.baseClient?.config?.region,
    });
    if (rawOut && rawOut.__isDiscoveryProxy) {
      return rawOut;
    }
    const base = (rawOut && typeof rawOut === 'object' && !Array.isArray(rawOut))
      ? { ...rawOut }
      : { Item: rawOut };
    if (!base.$metadata) {
      base.$metadata = { httpStatusCode: 200, requestId: globalThis.crypto.randomUUID() };
    }
    return base;
  }
}

export class GetCommand extends DocCommand { constructor(i) { super(i, 'GetItem'); } }
export class PutCommand extends DocCommand { constructor(i) { super(i, 'PutItem'); } }
export class UpdateCommand extends DocCommand { constructor(i) { super(i, 'UpdateItem'); } }
export class DeleteCommand extends DocCommand { constructor(i) { super(i, 'DeleteItem'); } }
export class QueryCommand extends DocCommand { constructor(i) { super(i, 'Query'); } }
export class ScanCommand extends DocCommand { constructor(i) { super(i, 'Scan'); } }
export class BatchWriteCommand extends DocCommand { constructor(i) { super(i, 'BatchWrite'); } }
`;

const BEDROCK_RUNTIME_CODE = `
function parseBodyInput(body) {
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return { prompt: body }; }
  }
  if (body instanceof Uint8Array) {
    try { return JSON.parse(new TextDecoder().decode(body)); } catch { return {}; }
  }
  return body || {};
}

export class InvokeModelCommand {
  constructor(input = {}) {
    this.input = input;
    this.__kind = 'invokeModel';
  }
}

export class ConverseCommand {
  constructor(input = {}) {
    this.input = input;
    this.__kind = 'converse';
  }
}

export class ConverseStreamCommand {
  constructor(input = {}) {
    this.input = input;
    this.__kind = 'converseStream';
  }
}

export class InvokeModelWithResponseStreamCommand {
  constructor(input = {}) {
    this.input = input;
    this.__kind = 'invokeStream';
  }
}

export class BedrockRuntimeClient {
  constructor(config = {}) {
    this.config = config;
  }
  async send(command) {
    const kind = command?.__kind || 'converse';
    const rawIn = command?.input ?? {};
    if (kind === 'converseStream' || kind === 'invokeStream') {
      const rawStream = globalThis.__infrasimCreateStream({
        kind: 'cloud',
        sdkStyle: 'bedrock',
        serviceId: 'aws.bedrock',
        op: 'InvokeStream',
        input: rawIn,
        region: this.config?.region,
        stream: true,
      });
      const wrappedStream = {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of rawStream) {
            if (chunk && typeof chunk === 'object' && (chunk.contentBlockDelta || chunk.chunk || chunk.messageStop || chunk.messageStart || chunk.metadata)) {
              yield chunk;
            } else {
              const text = typeof chunk === 'string'
                ? chunk.replace(/^data:\\s*/gm, '').trim()
                : (chunk?.delta ?? chunk?.text ?? chunk?.chunk ?? JSON.stringify(chunk ?? ''));
              if (kind === 'converseStream') {
                yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: String(text) } } };
              } else {
                yield { chunk: { bytes: globalThis.Buffer.from(JSON.stringify({ completion: String(text) })) } };
              }
            }
          }
        },
      };
      return {
        stream: wrappedStream,
        body: wrappedStream,
        $metadata: { httpStatusCode: 200, requestId: globalThis.crypto.randomUUID() },
      };
    }

    const op = rawIn?.modelId?.includes('embed') || rawIn?.inputText ? 'Embed' : 'Invoke';
    const parsedInput = kind === 'invokeModel'
      ? { modelId: rawIn.modelId, ...parseBodyInput(rawIn.body) }
      : rawIn;

    const rawOut = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'bedrock',
      serviceId: 'aws.bedrock',
      op,
      input: parsedInput,
      region: this.config?.region,
    });
    if (rawOut && rawOut.__isDiscoveryProxy) {
      return rawOut;
    }

    if (kind === 'invokeModel') {
      const enriched =
        rawOut && typeof rawOut === 'object' && !Array.isArray(rawOut) && !('id' in rawOut)
          ? { id: 'resp-' + globalThis.crypto.randomUUID().slice(0, 8), ...rawOut }
          : rawOut;
      const jsonStr = typeof enriched === 'string' ? enriched : JSON.stringify(enriched);
      return {
        contentType: 'application/json',
        body: globalThis.Buffer.from(jsonStr),
        $metadata: { httpStatusCode: 200, requestId: globalThis.crypto.randomUUID() },
      };
    }

    return {
      ...(rawOut && typeof rawOut === 'object' ? rawOut : { output: { message: { role: 'assistant', content: [{ text: String(rawOut ?? '') }] } } }),
      $metadata: { httpStatusCode: 200, requestId: globalThis.crypto.randomUUID() },
    };
  }
}
`;

const GCP_STORAGE_CODE = `
class SimGcsFile {
  constructor(bucketName, name) { this.bucketName = bucketName; this.name = name; }
  async download() {
    const out = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.cloud_storage',
      op: 'GetObject',
      input: { bucket: this.bucketName, name: this.name },
    });
    if (out && out.__isDiscoveryProxy) return [out];
    const body = typeof out?.Body === 'string' ? out.Body : JSON.stringify(out ?? {});
    return [globalThis.Buffer.from(body)];
  }
  async save(contents) {
    const sizeBytes = typeof contents === 'string' ? contents.length : (contents?.byteLength || 0);
    await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.cloud_storage',
      op: 'PutObject',
      input: { bucket: this.bucketName, name: this.name, sizeBytes },
    });
  }
  async delete() {
    await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.cloud_storage',
      op: 'DeleteObject',
      input: { bucket: this.bucketName, name: this.name },
    });
    return [{}];
  }
  async exists() {
    await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.cloud_storage',
      op: 'HeadObject',
      input: { bucket: this.bucketName, name: this.name },
    });
    return [true];
  }
}
class SimGcsBucket {
  constructor(name) { this.name = name; }
  file(fileName) { return new SimGcsFile(this.name, fileName); }
  async getFiles() {
    const out = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.cloud_storage',
      op: 'ListObjects',
      input: { bucket: this.name },
    });
    if (out && out.__isDiscoveryProxy) return [out];
    const files = (out?.Contents || out?.items || []).map((c) => new SimGcsFile(this.name, c.Key || c.name || 'item'));
    return [files];
  }
}
export class Storage {
  constructor(cfg = {}) { this.cfg = cfg; }
  bucket(name) { return new SimGcsBucket(name); }
}
export default { Storage };
`;

const GCP_PUBSUB_CODE = `
class SimTopic {
  constructor(name) { this.name = name; }
  async publishMessage(msg = {}) {
    const out = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.pubsub',
      op: 'Publish',
      input: { topic: this.name, ...msg },
    });
    if (out && out.__isDiscoveryProxy) return out;
    return out?.messageId || out?.MessageId || globalThis.crypto.randomUUID();
  }
  async publishJSON(json, attributes = {}) {
    return this.publishMessage({ json, attributes });
  }
}
export class PubSub {
  constructor(cfg = {}) { this.cfg = cfg; }
  topic(name) { return new SimTopic(name); }
}
export default { PubSub };
`;

const GCP_FIRESTORE_CODE = `
class SimDocRef {
  constructor(col, id) { this.col = col; this.id = id; }
  async get() {
    const out = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.firestore',
      op: 'Find',
      input: { collection: this.col, id: this.id },
    });
    if (out && out.__isDiscoveryProxy) {
      return { id: this.id, exists: true, data: () => out };
    }
    const payload = out?.document || out?.Item || out?.documents?.[0] || out;
    return { id: this.id, exists: Boolean(payload), data: () => payload };
  }
  async set(data) {
    return globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.firestore',
      op: 'Insert',
      input: { collection: this.col, id: this.id, document: data },
    });
  }
  async update(data) {
    return globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.firestore',
      op: 'Update',
      input: { collection: this.col, id: this.id, document: data },
    });
  }
}
class SimColRef {
  constructor(name) { this.name = name; }
  doc(id = globalThis.crypto.randomUUID()) { return new SimDocRef(this.name, id); }
  async add(data) {
    const id = globalThis.crypto.randomUUID();
    await new SimDocRef(this.name, id).set(data);
    return new SimDocRef(this.name, id);
  }
  async get() {
    const out = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.firestore',
      op: 'Find',
      input: { collection: this.name },
    });
    const list = Array.isArray(out?.documents || out?.Items) ? (out.documents || out.Items) : [];
    const docs = list.map((d, idx) => ({ id: d.id || String(idx), exists: true, data: () => d }));
    return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn) };
  }
}
export class Firestore {
  constructor(cfg = {}) { this.cfg = cfg; }
  collection(name) { return new SimColRef(name); }
}
export default { Firestore };
`;

const GCP_SECRET_MANAGER_CODE = `
export class SecretManagerServiceClient {
  constructor(cfg = {}) { this.cfg = cfg; }
  async accessSecretVersion(req = {}) {
    const out = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.secret_manager',
      op: 'GetSecret',
      input: req,
    });
    if (out && out.__isDiscoveryProxy) return [{ payload: { data: out } }];
    const secretVal = out?.SecretString || out?.value || JSON.stringify(out ?? {});
    return [{ name: req.name || 'secret/versions/1', payload: { data: globalThis.Buffer.from(String(secretVal)) } }];
  }
}
export default { SecretManagerServiceClient };
`;

const GCP_VERTEXAI_CODE = `
class SimGenerativeModel {
  constructor(opts = {}) { this.opts = opts; }
  async generateContent(req) {
    const rawOut = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.vertex_gemini',
      op: 'Invoke',
      input: { model: this.opts.model, contents: req },
    });
    if (rawOut && rawOut.__isDiscoveryProxy) {
      return { response: rawOut };
    }
    if (rawOut?.candidates) {
      return { response: rawOut };
    }
    const text = rawOut?.output?.message?.content?.[0]?.text ?? rawOut?.text ?? '';
    return {
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: rawOut?.usage?.inputTokens ?? 32,
          candidatesTokenCount: rawOut?.usage?.outputTokens ?? 16,
          totalTokenCount: rawOut?.usage?.totalTokens ?? 48,
        },
      },
    };
  }
  async generateContentStream(req) {
    const rawStream = globalThis.__infrasimCreateStream({
      kind: 'cloud',
      sdkStyle: 'gcp',
      serviceId: 'gcp.vertex_gemini',
      op: 'InvokeStream',
      input: { model: this.opts.model, contents: req },
      stream: true,
    });
    const stream = {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of rawStream) {
          if (chunk && typeof chunk === 'object' && chunk.candidates) {
            yield chunk;
          } else {
            const text = typeof chunk === 'string'
              ? chunk.replace(/^data:\\s*/gm, '').trim()
              : (chunk?.delta ?? chunk?.text ?? chunk?.chunk ?? '');
            yield { candidates: [{ content: { role: 'model', parts: [{ text: String(text) }] } }] };
          }
        }
      },
    };
    return {
      stream,
      response: Promise.resolve({ candidates: [], usageMetadata: {} }),
    };
  }
}
export class VertexAI {
  constructor(cfg = {}) { this.cfg = cfg; }
  getGenerativeModel(opts) { return new SimGenerativeModel(opts); }
}
export default { VertexAI };
`;

const AZURE_BLOB_CODE = `
class SimBlockBlobClient {
  constructor(containerName, blobName) { this.containerName = containerName; this.blobName = blobName; }
  async downloadToBuffer() {
    const out = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'azure',
      serviceId: 'azure.blob',
      op: 'GetObject',
      input: { container: this.containerName, blob: this.blobName },
    });
    if (out && out.__isDiscoveryProxy) return out;
    const text = typeof out?.Body === 'string' ? out.Body : JSON.stringify(out ?? {});
    return globalThis.Buffer.from(text);
  }
  async upload(data, length) {
    return globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'azure',
      serviceId: 'azure.blob',
      op: 'PutObject',
      input: { container: this.containerName, blob: this.blobName, sizeBytes: length || (data?.length ?? 0) },
    });
  }
  async delete() {
    return globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'azure',
      serviceId: 'azure.blob',
      op: 'DeleteObject',
      input: { container: this.containerName, blob: this.blobName },
    });
  }
}
class SimContainerClient {
  constructor(name) { this.containerName = name; }
  getBlockBlobClient(blobName) { return new SimBlockBlobClient(this.containerName, blobName); }
  getBlobClient(blobName) { return new SimBlockBlobClient(this.containerName, blobName); }
}
export class BlobServiceClient {
  constructor(url = '') { this.url = url; }
  static fromConnectionString(cs) { return new BlobServiceClient(cs); }
  getContainerClient(name) { return new SimContainerClient(name); }
}
`;

const AZURE_COSMOS_CODE = `
class SimCosmosContainer {
  constructor(db, id) { this.db = db; this.id = id; }
  item(id, pk) {
    return {
      read: async () => {
        const res = await globalThis.__infrasimInvokeSdk({
          kind: 'cloud',
          sdkStyle: 'azure',
          serviceId: 'azure.cosmos_db',
          op: 'Find',
          input: { database: this.db, container: this.id, id, partitionKey: pk },
        });
        if (res && res.__isDiscoveryProxy) {
          return { resource: res, statusCode: 200 };
        }
        const doc = Array.isArray(res?.documents) ? res.documents[0] : (res?.Item ?? res);
        return { resource: doc, statusCode: 200 };
      },
      replace: async (body) => {
        const res = await globalThis.__infrasimInvokeSdk({
          kind: 'cloud',
          sdkStyle: 'azure',
          serviceId: 'azure.cosmos_db',
          op: 'Update',
          input: { database: this.db, container: this.id, id, body },
        });
        return { resource: res, statusCode: 200 };
      },
    };
  }
  get items() {
    return {
      create: async (body) => {
        const res = await globalThis.__infrasimInvokeSdk({
          kind: 'cloud',
          sdkStyle: 'azure',
          serviceId: 'azure.cosmos_db',
          op: 'Insert',
          input: { database: this.db, container: this.id, body },
        });
        return { resource: res, statusCode: 201 };
      },
      query: (querySpec) => ({
        fetchAll: async () => {
          const res = await globalThis.__infrasimInvokeSdk({
            kind: 'cloud',
            sdkStyle: 'azure',
            serviceId: 'azure.cosmos_db',
            op: 'Find',
            input: { database: this.db, container: this.id, query: querySpec },
          });
          const resources = res?.Items || res?.documents || (Array.isArray(res) ? res : [res]);
          return { resources };
        },
      }),
    };
  }
}
export class CosmosClient {
  constructor(cfg = {}) { this.cfg = cfg; }
  database(dbId) {
    return { container: (cId) => new SimCosmosContainer(dbId, cId) };
  }
}
`;

const AZURE_SERVICE_BUS_CODE = `
export class ServiceBusClient {
  constructor(cs = '') { this.cs = cs; }
  createSender(queueOrTopic) {
    return {
      sendMessages: async (messages) => globalThis.__infrasimInvokeSdk({
        kind: 'cloud',
        sdkStyle: 'azure',
        serviceId: 'azure.service_bus',
        op: 'Send',
        input: { destination: queueOrTopic, messages },
      }),
      close: async () => {},
    };
  }
  createReceiver(queueOrTopic) {
    return {
      receiveMessages: async (maxMessageCount = 1) => {
        const out = await globalThis.__infrasimInvokeSdk({
          kind: 'cloud',
          sdkStyle: 'azure',
          serviceId: 'azure.service_bus',
          op: 'Receive',
          input: { source: queueOrTopic, maxMessageCount },
        });
        return Array.isArray(out?.Messages) ? out.Messages : (Array.isArray(out) ? out : [{ body: out }]);
      },
      completeMessage: async (msg) => globalThis.__infrasimInvokeSdk({
        kind: 'cloud',
        sdkStyle: 'azure',
        serviceId: 'azure.service_bus',
        op: 'Delete',
        input: { source: queueOrTopic, messageId: msg?.messageId },
      }),
      close: async () => {},
    };
  }
}
`;

const AZURE_KEYVAULT_CODE = `
export class SecretClient {
  constructor(vaultUrl = '', _cred) { this.vaultUrl = vaultUrl; }
  async getSecret(name) {
    const out = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'azure',
      serviceId: 'azure.key_vault',
      op: 'GetSecret',
      input: { vaultUrl: this.vaultUrl, name },
    });
    if (out && out.__isDiscoveryProxy) return out;
    return { name, value: out?.SecretString || out?.value || '', properties: { vaultUrl: this.vaultUrl } };
  }
}
`;

const OPENAI_CODE = `
class OpenAIClient {
  constructor(cfg = {}) {
    this.cfg = cfg;
    const isBedrock = cfg?.serviceId === 'aws.bedrock';
    this.serviceId = cfg?.serviceId || (isBedrock ? 'aws.bedrock' : 'azure.openai');
    this.chat = {
      completions: {
        create: async (params = {}) => {
          if (params.stream) {
            const rawStream = globalThis.__infrasimCreateStream({
              kind: 'cloud',
              sdkStyle: 'azure',
              serviceId: this.serviceId,
              op: 'InvokeStream',
              input: params,
              stream: true,
            });
            const streamId = 'chatcmpl-' + globalThis.crypto.randomUUID().slice(0, 12);
            const modelName = params.model || this.cfg.deployment || 'gpt-mock';
            return {
              async *[Symbol.asyncIterator]() {
                for await (const chunk of rawStream) {
                  if (chunk && typeof chunk === 'object' && Array.isArray(chunk.choices)) {
                    yield chunk;
                  } else {
                    const text = typeof chunk === 'string'
                      ? chunk.replace(/^data:\\s*/gm, '').trim()
                      : (chunk?.delta ?? chunk?.text ?? chunk?.chunk ?? '');
                    yield {
                      id: streamId,
                      object: 'chat.completion.chunk',
                      model: modelName,
                      choices: [{ index: 0, delta: { content: String(text) }, finish_reason: chunk?.finishReason || null }],
                    };
                  }
                }
              },
            };
          }
          const rawOut = await globalThis.__infrasimInvokeSdk({
            kind: 'cloud',
            sdkStyle: 'azure',
            serviceId: this.serviceId,
            op: 'Invoke',
            input: params,
          });
          if (rawOut && rawOut.__isDiscoveryProxy) return rawOut;
          if (rawOut?.choices) return rawOut;
          const text = rawOut?.output?.message?.content?.[0]?.text ?? rawOut?.text ?? '';
          const usage = rawOut?.usage || {};
          const promptTokens = usage.inputTokens ?? usage.prompt_tokens ?? 32;
          const compTokens = usage.outputTokens ?? usage.completion_tokens ?? 16;
          return {
            id: rawOut?.id || 'chatcmpl-' + globalThis.crypto.randomUUID().slice(0, 12),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: params.model || this.cfg.deployment || 'gpt-mock',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: promptTokens, completion_tokens: compTokens, total_tokens: promptTokens + compTokens },
          };
        },
      },
    };
    this.embeddings = {
      create: async (params = {}) => {
        const rawOut = await globalThis.__infrasimInvokeSdk({
          kind: 'cloud',
          sdkStyle: 'azure',
          serviceId: this.serviceId,
          op: 'Embed',
          input: params,
        });
        if (rawOut && rawOut.__isDiscoveryProxy) return rawOut;
        const vec = rawOut?.embedding || rawOut?.embeddings?.[0] || [0.01, -0.02, 0.03];
        return {
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: vec }],
          usage: { prompt_tokens: rawOut?.usage?.inputTokens ?? 16, total_tokens: rawOut?.usage?.inputTokens ?? 16 },
        };
      },
    };
  }
}
export class OpenAI extends OpenAIClient {}
export class AzureOpenAI extends OpenAIClient {}
export default OpenAI;
`;

const OCI_COMMON_CODE = `
export class SimpleAuthenticationDetailsProvider {
  constructor(tenancy, user, fingerprint, privateKey, passphrase, region) {
    this.region = region;
  }
}
export class ConfigFileAuthenticationDetailsProvider {}
export const Region = {
  US_ASHBURN_1: 'us-ashburn-1',
  US_PHOENIX_1: 'us-phoenix-1',
  EU_FRANKFURT_1: 'eu-frankfurt-1',
};
`;

const OCI_OBJECT_STORAGE_CODE = `
export class ObjectStorageClient {
  constructor(cfg = {}) { this.cfg = cfg; }
  async getObject(req = {}) {
    const out = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'oci',
      serviceId: 'oci.object_storage',
      op: 'GetObject',
      input: req,
    });
    if (out && out.__isDiscoveryProxy) return out;
    const text = typeof out?.Body === 'string' ? out.Body : JSON.stringify(out ?? {});
    return { value: text, contentLength: text.length, eTag: out?.ETag || 'mock-etag', opcRequestId: globalThis.crypto.randomUUID() };
  }
  async putObject(req = {}) {
    return globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'oci',
      serviceId: 'oci.object_storage',
      op: 'PutObject',
      input: req,
    });
  }
  async deleteObject(req = {}) {
    return globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'oci',
      serviceId: 'oci.object_storage',
      op: 'DeleteObject',
      input: req,
    });
  }
  async listObjects(req = {}) {
    return globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'oci',
      serviceId: 'oci.object_storage',
      op: 'ListObjects',
      input: req,
    });
  }
}
`;

const OCI_GENAI_CODE = `
export class GenerativeAiInferenceClient {
  constructor(cfg = {}) { this.cfg = cfg; }
  async chat(req = {}) {
    const rawOut = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'oci',
      serviceId: 'oci.genai',
      op: 'Invoke',
      input: req,
    });
    if (rawOut && rawOut.__isDiscoveryProxy) return { chatResult: rawOut };
    if (rawOut?.chatResponse) return { chatResult: rawOut };
    const text = rawOut?.output?.message?.content?.[0]?.text ?? '';
    return {
      chatResult: {
        modelId: req?.chatDetails?.servingMode?.modelId || 'oci.genai-mock',
        chatResponse: {
          choices: [{ message: { role: 'ASSISTANT', content: [{ type: 'TEXT', text }] }, finishReason: 'stop' }],
          usage: {
            promptTokens: rawOut?.usage?.inputTokens ?? 32,
            completionTokens: rawOut?.usage?.outputTokens ?? 16,
            totalTokens: rawOut?.usage?.totalTokens ?? 48,
          },
        },
      },
      opcRequestId: globalThis.crypto.randomUUID(),
    };
  }
  async embedText(req = {}) {
    const rawOut = await globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'oci',
      serviceId: 'oci.genai',
      op: 'Embed',
      input: req,
    });
    return { embedTextResult: rawOut, opcRequestId: globalThis.crypto.randomUUID() };
  }
}
`;

const OCI_QUEUE_CODE = `
export class QueueClient {
  constructor(cfg = {}) { this.cfg = cfg; }
  async putMessages(req = {}) {
    return globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'oci',
      serviceId: 'oci.queue',
      op: 'Send',
      input: req,
    });
  }
  async getMessages(req = {}) {
    return globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'oci',
      serviceId: 'oci.queue',
      op: 'Receive',
      input: req,
    });
  }
  async deleteMessage(req = {}) {
    return globalThis.__infrasimInvokeSdk({
      kind: 'cloud',
      sdkStyle: 'oci',
      serviceId: 'oci.queue',
      op: 'Delete',
      input: req,
    });
  }
}
`;

/** Generates drop-in SDK shim code for AWS, GCP, Azure, and OCI client libraries. */
export function generateCloudSdkShimModule(specifier: string): string | null {
  if (specifier === '@aws-sdk/lib-dynamodb') return LIB_DYNAMODB_CODE;
  if (specifier === '@aws-sdk/client-bedrock-runtime') return BEDROCK_RUNTIME_CODE;
  if (specifier.startsWith('@aws-sdk/client-')) return buildAwsV3GenericCode(specifier);

  if (specifier === '@google-cloud/storage') return GCP_STORAGE_CODE;
  if (specifier === '@google-cloud/pubsub') return GCP_PUBSUB_CODE;
  if (specifier === '@google-cloud/firestore') return GCP_FIRESTORE_CODE;
  if (specifier === '@google-cloud/secret-manager') return GCP_SECRET_MANAGER_CODE;
  if (specifier === '@google-cloud/vertexai') return GCP_VERTEXAI_CODE;

  if (specifier === '@azure/storage-blob') return AZURE_BLOB_CODE;
  if (specifier === '@azure/cosmos') return AZURE_COSMOS_CODE;
  if (specifier === '@azure/service-bus') return AZURE_SERVICE_BUS_CODE;
  if (specifier === '@azure/keyvault-secrets') return AZURE_KEYVAULT_CODE;
  if (specifier === 'openai') return OPENAI_CODE;

  if (specifier === 'oci-common') return OCI_COMMON_CODE;
  if (specifier === 'oci-objectstorage') return OCI_OBJECT_STORAGE_CODE;
  if (specifier === 'oci-generativeaiinference') return OCI_GENAI_CODE;
  if (specifier === 'oci-queue') return OCI_QUEUE_CODE;

  return null;
}
