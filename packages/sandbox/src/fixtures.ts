import { validateJsonSchemaValue, type SchemaValidationResult } from '@infrasim/catalog';
import type {
  Design,
  FixtureTemplateId,
  NodeInstance,
  PayloadFixture,
  ScriptAsset,
  ServiceDefinition,
} from '@infrasim/shared-types';
import { createSeededPrng, hashSeedParts, type SeededPrng } from './prng.js';
import { executeInSandbox } from './runtime.js';
import type { DryRunResult, MockCallResolver, SandboxLimits } from './types.js';

export interface FixtureTemplateDefinition {
  id: FixtureTemplateId;
  label: string;
  provider: 'aws' | 'gcp' | 'azure' | 'oci' | 'generic';
  description: string;
  defaultEvent: unknown;
  defaultContext?: Record<string, unknown>;
  defaultSchema?: Record<string, unknown>;
  defaultExpectedStatus?: number;
}

export interface FixtureSuiteItemResult {
  fixtureId: string;
  fixtureName: string;
  passed: boolean;
  reason?: string;
  expectedStatus?: number;
  actualStatus?: number;
  virtualDurationMs: number;
  dryRunResult: DryRunResult;
}

export interface FixtureSuiteReport {
  total: number;
  passed: number;
  failed: number;
  results: FixtureSuiteItemResult[];
}

export const FIXTURE_TEMPLATES: readonly FixtureTemplateDefinition[] = [
  {
    id: 'aws.apigw.proxy.v1',
    label: 'AWS API Gateway REST Proxy (v1)',
    provider: 'aws',
    description:
      'REST API proxy integration event with stringified JSON body and null query params.',
    defaultExpectedStatus: 200,
    defaultEvent: {
      resource: '/orders/{id}',
      path: '/orders/ord-101',
      httpMethod: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      queryStringParameters: null,
      pathParameters: { id: 'ord-101' },
      isBase64Encoded: false,
      body: JSON.stringify({ orderId: 'ord-101', itemId: 'sku-42', quantity: 2 }),
      requestContext: {
        accountId: '123456789012',
        stage: 'prod',
        requestId: 'apigw-v1-req-1',
        httpMethod: 'POST',
      },
    },
    defaultContext: {
      functionName: 'orders-api',
      memoryLimitInMB: '128',
    },
    defaultSchema: {
      type: 'object',
      required: ['httpMethod', 'path', 'body'],
      properties: {
        httpMethod: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', minLength: 1 },
        headers: { type: 'object' },
        queryStringParameters: { type: ['object', 'null'] },
        isBase64Encoded: { type: 'boolean' },
        body: { type: ['string', 'null'] },
      },
    },
  },
  {
    id: 'aws.apigw.proxy.v2',
    label: 'AWS API Gateway HTTP API (v2)',
    provider: 'aws',
    description:
      'HTTP API v2 payload format with lowercase headers and requestContext.http.method.',
    defaultExpectedStatus: 200,
    defaultEvent: {
      version: '2.0',
      routeKey: 'POST /orders',
      rawPath: '/orders',
      rawQueryString: '',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      isBase64Encoded: false,
      body: JSON.stringify({ orderId: 'ord-202', amount: 49.95 }),
      requestContext: {
        accountId: '123456789012',
        stage: '$default',
        requestId: 'apigw-v2-req-1',
        http: {
          method: 'POST',
          path: '/orders',
          protocol: 'HTTP/1.1',
          sourceIp: '203.0.113.10',
        },
      },
    },
    defaultSchema: {
      type: 'object',
      required: ['version', 'rawPath', 'requestContext'],
      properties: {
        version: { type: 'string', enum: ['2.0'] },
        rawPath: { type: 'string', minLength: 1 },
        rawQueryString: { type: 'string' },
        headers: { type: 'object' },
        body: { type: ['string', 'null'] },
        isBase64Encoded: { type: 'boolean' },
        requestContext: {
          type: 'object',
          required: ['http'],
          properties: {
            http: {
              type: 'object',
              required: ['method', 'path'],
              properties: {
                method: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'aws.alb.target',
    label: 'AWS Application Load Balancer Target',
    provider: 'aws',
    description: 'ALB Lambda target event with requestContext.elb metadata.',
    defaultExpectedStatus: 200,
    defaultEvent: {
      requestContext: {
        elb: {
          targetGroupArn:
            'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/api/50dc6c495c0c9188',
        },
      },
      httpMethod: 'GET',
      path: '/health',
      queryStringParameters: {},
      headers: {
        host: 'api.example.com',
        accept: 'application/json',
      },
      body: '',
      isBase64Encoded: false,
    },
    defaultSchema: {
      type: 'object',
      required: ['httpMethod', 'path', 'requestContext'],
      properties: {
        httpMethod: { type: 'string' },
        path: { type: 'string' },
        headers: { type: 'object' },
        queryStringParameters: { type: 'object' },
        body: { type: 'string' },
        isBase64Encoded: { type: 'boolean' },
      },
    },
  },
  {
    id: 'aws.sqs',
    label: 'AWS SQS Batch Event',
    provider: 'aws',
    description: 'SQS event source mapping batch with stringified record body.',
    defaultEvent: {
      Records: [
        {
          messageId: '059f36b4-87a3-44ab-83d2-661975830a7d',
          receiptHandle: 'AQEBwJnKyrHigUMZj6rYigCgxlaS3SLy0a...',
          body: JSON.stringify({ orderId: 'ord-303', action: 'fulfill' }),
          attributes: {
            ApproximateReceiveCount: '1',
            SentTimestamp: '1700000000000',
          },
          messageAttributes: {},
          eventSource: 'aws:sqs',
          awsRegion: 'us-east-1',
        },
      ],
    },
    defaultSchema: {
      type: 'object',
      required: ['Records'],
      properties: {
        Records: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['messageId', 'body'],
            properties: {
              messageId: { type: 'string' },
              body: { type: 'string' },
              eventSource: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    id: 'aws.sns',
    label: 'AWS SNS Notification Event',
    provider: 'aws',
    description: 'SNS topic Lambda subscription event with nested Message JSON string.',
    defaultEvent: {
      Records: [
        {
          EventSource: 'aws:sns',
          EventVersion: '1.0',
          Sns: {
            Type: 'Notification',
            MessageId: '95df01b4-ee98-5cb9-9903-4c221d41eb5e',
            TopicArn: 'arn:aws:sns:us-east-1:123456789012:order-events',
            Subject: 'OrderCreated',
            Message: JSON.stringify({ orderId: 'ord-404', status: 'paid' }),
            Timestamp: '2026-01-15T12:00:00.000Z',
          },
        },
      ],
    },
    defaultSchema: {
      type: 'object',
      required: ['Records'],
      properties: {
        Records: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['EventSource', 'Sns'],
            properties: {
              EventSource: { type: 'string' },
              Sns: {
                type: 'object',
                required: ['MessageId', 'Message'],
                properties: {
                  MessageId: { type: 'string' },
                  Subject: { type: 'string' },
                  Message: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'aws.s3.notification',
    label: 'AWS S3 Object Notification',
    provider: 'aws',
    description: 'S3 Put notification with URL-encoded object key.',
    defaultEvent: {
      Records: [
        {
          eventVersion: '2.1',
          eventSource: 'aws:s3',
          awsRegion: 'us-east-1',
          eventTime: '2026-01-15T12:00:00.000Z',
          eventName: 'ObjectCreated:Put',
          s3: {
            bucket: { name: 'uploads-bucket' },
            object: {
              key: 'uploads/monthly+report%202026.json',
              size: 4096,
              eTag: '0123456789abcdef0123456789abcdef',
            },
          },
        },
      ],
    },
    defaultSchema: {
      type: 'object',
      required: ['Records'],
      properties: {
        Records: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['eventSource', 's3'],
            properties: {
              eventSource: { type: 'string' },
              eventName: { type: 'string' },
              s3: {
                type: 'object',
                required: ['bucket', 'object'],
                properties: {
                  bucket: {
                    type: 'object',
                    required: ['name'],
                    properties: { name: { type: 'string' } },
                  },
                  object: {
                    type: 'object',
                    required: ['key', 'size'],
                    properties: {
                      key: { type: 'string' },
                      size: { type: 'integer', minimum: 0 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'aws.dynamodb.stream',
    label: 'AWS DynamoDB Stream Event',
    provider: 'aws',
    description: 'DynamoDB Streams INSERT batch record using AttributeValue maps.',
    defaultEvent: {
      Records: [
        {
          eventID: '1',
          eventName: 'INSERT',
          eventSource: 'aws:dynamodb',
          awsRegion: 'us-east-1',
          dynamodb: {
            Keys: { id: { S: 'usr-101' } },
            NewImage: {
              id: { S: 'usr-101' },
              email: { S: 'ada@example.com' },
            },
            SequenceNumber: '111',
            StreamViewType: 'NEW_AND_OLD_IMAGES',
          },
        },
      ],
    },
    defaultSchema: {
      type: 'object',
      required: ['Records'],
      properties: {
        Records: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['eventID', 'eventName', 'dynamodb'],
            properties: {
              eventID: { type: 'string' },
              eventName: { type: 'string', enum: ['INSERT', 'MODIFY', 'REMOVE'] },
              dynamodb: { type: 'object' },
            },
          },
        },
      },
    },
  },
  {
    id: 'aws.eventbridge',
    label: 'AWS EventBridge Event',
    provider: 'aws',
    description: 'Structured EventBridge custom application bus event.',
    defaultEvent: {
      version: '0',
      id: '6a7e8feb-b491-4cf7-a9f1-bf3703467718',
      'detail-type': 'OrderPaid',
      source: 'app.billing',
      account: '123456789012',
      time: '2026-01-15T12:00:00Z',
      region: 'us-east-1',
      resources: [],
      detail: {
        orderId: 'ord-707',
        amountUsd: 129.5,
      },
    },
    defaultSchema: {
      type: 'object',
      required: ['source', 'detail-type', 'detail'],
      properties: {
        id: { type: 'string' },
        source: { type: 'string' },
        'detail-type': { type: 'string' },
        time: { type: 'string', format: 'date-time' },
        detail: { type: 'object' },
      },
    },
  },
  {
    id: 'aws.kinesis',
    label: 'AWS Kinesis Data Stream Event',
    provider: 'aws',
    description: 'Kinesis batch event with base64-encoded kinesis.data payload.',
    defaultEvent: {
      Records: [
        {
          eventID: 'shardId-000000000000:49545115243490985018280067714973144582180062593244200961',
          eventSource: 'aws:kinesis',
          awsRegion: 'us-east-1',
          kinesis: {
            kinesisSchemaVersion: '1.0',
            partitionKey: 'user-101',
            sequenceNumber: '49545115243490985018280067714973144582180062593244200961',
            data: 'eyJldmVudCI6InBhZ2VfdmlldyIsInVzZXJJZCI6InVzci0xMDEifQ==',
          },
        },
      ],
    },
    defaultSchema: {
      type: 'object',
      required: ['Records'],
      properties: {
        Records: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['eventSource', 'kinesis'],
            properties: {
              eventSource: { type: 'string' },
              kinesis: {
                type: 'object',
                required: ['partitionKey', 'data'],
                properties: {
                  partitionKey: { type: 'string' },
                  data: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    id: 'gcp.http.request',
    label: 'GCP Cloud Functions / Run HTTP Request',
    provider: 'gcp',
    description: 'HTTP trigger payload mapped to Web Request/Express adapter.',
    defaultExpectedStatus: 200,
    defaultEvent: {
      method: 'POST',
      path: '/items',
      headers: {
        'content-type': 'application/json',
      },
      query: { filter: 'active' },
      body: { name: 'widget', count: 3 },
    },
    defaultSchema: {
      type: 'object',
      required: ['method', 'path'],
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        path: { type: 'string' },
        headers: { type: 'object' },
        query: { type: 'object' },
        body: { type: 'object' },
      },
    },
  },
  {
    id: 'gcp.pubsub.push',
    label: 'GCP Pub/Sub Push Message',
    provider: 'gcp',
    description: 'Pub/Sub push subscription envelope with base64 message.data.',
    defaultEvent: {
      message: {
        data: 'eyJ1c2VySWQiOiJ1c3ItMTAxIiwiYWN0aW9uIjoic3luYyJ9',
        messageId: '9876543210',
        attributes: { origin: 'checkout' },
        publishTime: '2026-01-15T12:00:00.000Z',
      },
      subscription: 'projects/infrasim-demo/subscriptions/orders-sub',
    },
    defaultSchema: {
      type: 'object',
      required: ['message', 'subscription'],
      properties: {
        subscription: { type: 'string' },
        message: {
          type: 'object',
          required: ['data', 'messageId'],
          properties: {
            data: { type: 'string' },
            messageId: { type: 'string' },
            attributes: { type: 'object' },
          },
        },
      },
    },
  },
  {
    id: 'gcp.storage.event',
    label: 'GCP Cloud Storage Object Event',
    provider: 'gcp',
    description: 'CloudEvent storage finalize notification.',
    defaultEvent: {
      bucket: 'infrasim-assets',
      name: 'reports/daily-summary.csv',
      contentType: 'text/csv',
      size: '8192',
      metageneration: '1',
      timeCreated: '2026-01-15T12:00:00.000Z',
    },
    defaultSchema: {
      type: 'object',
      required: ['bucket', 'name'],
      properties: {
        bucket: { type: 'string' },
        name: { type: 'string' },
        contentType: { type: 'string' },
        size: { type: 'string' },
      },
    },
  },
  {
    id: 'azure.http.trigger',
    label: 'Azure Functions HTTP Trigger',
    provider: 'azure',
    description: 'Azure Functions HTTP trigger request model.',
    defaultExpectedStatus: 200,
    defaultEvent: {
      method: 'POST',
      url: 'https://infrasim.azurewebsites.net/api/orders',
      headers: {
        'content-type': 'application/json',
      },
      query: { env: 'prod' },
      params: {},
      body: { orderId: 'az-ord-1', total: 89.0 },
    },
    defaultSchema: {
      type: 'object',
      required: ['method', 'url'],
      properties: {
        method: { type: 'string' },
        url: { type: 'string' },
        headers: { type: 'object' },
        query: { type: 'object' },
        body: { type: 'object' },
      },
    },
  },
  {
    id: 'azure.queue.trigger',
    label: 'Azure Storage Queue Trigger',
    provider: 'azure',
    description: 'Azure Functions Queue Storage trigger payload.',
    defaultEvent: {
      queueMessage: {
        id: 'az-qmsg-101',
        body: { jobId: 'job-900', retry: 0 },
        dequeueCount: 1,
        insertionTime: '2026-01-15T12:00:00Z',
      },
    },
    defaultSchema: {
      type: 'object',
      required: ['queueMessage'],
      properties: {
        queueMessage: {
          type: 'object',
          required: ['id', 'body'],
          properties: {
            id: { type: 'string' },
            body: { type: 'object' },
            dequeueCount: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
  {
    id: 'azure.eventgrid',
    label: 'Azure Event Grid Event',
    provider: 'azure',
    description: 'Azure Event Grid storage/resource notification payload.',
    defaultEvent: {
      id: 'eg-evt-101',
      eventType: 'Microsoft.Storage.BlobCreated',
      subject: '/blobServices/default/containers/assets/blobs/invoice.pdf',
      eventTime: '2026-01-15T12:00:00Z',
      dataVersion: '1.0',
      data: {
        api: 'PutBlob',
        contentType: 'application/pdf',
        contentLength: 14200,
      },
    },
    defaultSchema: {
      type: 'object',
      required: ['id', 'eventType', 'subject', 'data'],
      properties: {
        id: { type: 'string' },
        eventType: { type: 'string' },
        subject: { type: 'string' },
        eventTime: { type: 'string', format: 'date-time' },
        data: { type: 'object' },
      },
    },
  },
  {
    id: 'oci.functions.http',
    label: 'OCI Functions API Gateway HTTP',
    provider: 'oci',
    description: 'Oracle Functions API Gateway HTTP request payload.',
    defaultExpectedStatus: 200,
    defaultEvent: {
      requestUrl: 'https://apigw.us-ashburn-1.oraclecloud.com/v1/items',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: { id: 'oci-item-1', action: 'process' },
    },
    defaultSchema: {
      type: 'object',
      required: ['method', 'requestUrl'],
      properties: {
        requestUrl: { type: 'string' },
        method: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'object' },
      },
    },
  },
  {
    id: 'generic.json',
    label: 'Generic JSON Payload',
    provider: 'generic',
    description: 'Minimal structured JSON event for custom functions and scripts.',
    defaultExpectedStatus: 200,
    defaultEvent: {
      id: 'evt-1',
      action: 'process',
      userId: 'user-101',
      data: { message: 'hello infrasim' },
    },
    defaultSchema: {
      type: 'object',
      required: ['id', 'action'],
      properties: {
        id: { type: 'string' },
        action: { type: 'string' },
        userId: { type: 'string' },
        data: { type: 'object' },
      },
    },
  },
];

const TEMPLATE_BY_ID = new Map<FixtureTemplateId, FixtureTemplateDefinition>(
  FIXTURE_TEMPLATES.map((t) => [t.id, t]),
);

/** Lists all built-in fixture template definitions. */
export function listFixtureTemplates(): readonly FixtureTemplateDefinition[] {
  return FIXTURE_TEMPLATES;
}

/** Creates a new `PayloadFixture` initialized from one of the 17 built-in event templates. */
export function createFixtureFromTemplate(
  templateId: FixtureTemplateId,
  overrides: Partial<Omit<PayloadFixture, 'template'>> & { id?: string; name?: string } = {},
): PayloadFixture {
  const def = TEMPLATE_BY_ID.get(templateId) ?? TEMPLATE_BY_ID.get('generic.json')!;
  return {
    id: overrides.id ?? `fixture-${def.id.replace(/\./g, '-')}`,
    name: overrides.name ?? def.label,
    template: def.id,
    event:
      overrides.event !== undefined
        ? structuredClone(overrides.event)
        : structuredClone(def.defaultEvent),
    ...((overrides.context ?? def.defaultContext)
      ? { context: structuredClone(overrides.context ?? def.defaultContext) }
      : {}),
    ...((overrides.schema ?? def.defaultSchema)
      ? { schema: structuredClone(overrides.schema ?? def.defaultSchema) }
      : {}),
    ...(overrides.expectedStatus !== undefined
      ? { expectedStatus: overrides.expectedStatus }
      : def.defaultExpectedStatus !== undefined
        ? { expectedStatus: def.defaultExpectedStatus }
        : {}),
    weight: overrides.weight ?? 1,
  };
}

function pickItem<T>(rng: SeededPrng, arr: readonly T[]): T {
  return arr[rng.int(0, arr.length - 1)]!;
}

function generateStringValue(
  schema: Record<string, unknown>,
  rng: SeededPrng,
  fieldName: string,
): string {
  const format = typeof schema.format === 'string' ? schema.format : '';
  const lowerField = fieldName.toLowerCase();

  if (
    format === 'uuid' ||
    lowerField === 'id' ||
    lowerField.endsWith('id') ||
    lowerField === 'uuid'
  ) {
    return rng.uuid();
  }
  if (format === 'email' || lowerField.includes('email')) {
    const idx = rng.int(100, 999);
    return `user${idx}@example.com`;
  }
  if (format === 'date-time' || lowerField.endsWith('at') || lowerField.includes('time')) {
    return '2026-01-15T12:00:00.000Z';
  }
  if (format === 'uri' || format === 'url' || lowerField.includes('url')) {
    return `https://example.com/resource/${rng.int(1, 999)}`;
  }
  if (format === 'ipv4' || lowerField.includes('ip')) {
    return `198.51.100.${rng.int(1, 250)}`;
  }
  if (lowerField === 'httpmethod' || lowerField === 'method') {
    return pickItem(rng, ['GET', 'POST', 'PUT']);
  }
  if (lowerField === 'path' || lowerField === 'rawpath') {
    return `/items/${rng.int(10, 99)}`;
  }
  if (lowerField === 'body') {
    return JSON.stringify({ id: rng.uuid(), ok: true });
  }
  if (lowerField.includes('name') || lowerField.includes('title')) {
    return `${pickItem(rng, ['Alpha', 'Bravo', 'Cedar', 'Delta'])} ${rng.int(10, 99)}`;
  }

  let base = `sample-${rng.hex(6)}`;
  const minLen = typeof schema.minLength === 'number' ? schema.minLength : 0;
  const maxLen = typeof schema.maxLength === 'number' ? schema.maxLength : 64;
  while (base.length < minLen) {
    base += `-${rng.hex(4)}`;
  }
  if (base.length > maxLen) {
    base = base.slice(0, maxLen);
  }
  return base;
}

function generateNodeFromSchema(
  schema: Record<string, unknown>,
  rng: SeededPrng,
  fieldName: string,
  depth: number,
): unknown {
  if (depth > 6) {
    return null;
  }

  if ('const' in schema) {
    return structuredClone(schema.const);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return structuredClone(pickItem(rng, schema.enum));
  }
  if ('default' in schema) {
    return structuredClone(schema.default);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const chosen = pickItem(rng, schema.oneOf);
    if (chosen && typeof chosen === 'object') {
      return generateNodeFromSchema(chosen as Record<string, unknown>, rng, fieldName, depth + 1);
    }
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const chosen = pickItem(rng, schema.anyOf);
    if (chosen && typeof chosen === 'object') {
      return generateNodeFromSchema(chosen as Record<string, unknown>, rng, fieldName, depth + 1);
    }
  }

  const rawType = schema.type;
  const primaryType = Array.isArray(rawType)
    ? (rawType.find((t) => t !== 'null') ?? rawType[0] ?? 'object')
    : typeof rawType === 'string'
      ? rawType
      : schema.properties
        ? 'object'
        : schema.items
          ? 'array'
          : 'string';

  switch (primaryType) {
    case 'null':
      return null;
    case 'boolean':
      return rng.next() >= 0.5;
    case 'integer': {
      const min = typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 1;
      const max =
        typeof schema.maximum === 'number' ? Math.floor(schema.maximum) : Math.max(min + 50, 100);
      return rng.int(min, Math.max(min, max));
    }
    case 'number': {
      const min = typeof schema.minimum === 'number' ? schema.minimum : 1;
      const max = typeof schema.maximum === 'number' ? schema.maximum : Math.max(min + 50, 100);
      const val = min + rng.next() * Math.max(1, max - min);
      return Number(val.toFixed(2));
    }
    case 'string':
      return generateStringValue(schema, rng, fieldName);
    case 'array': {
      const minItems = typeof schema.minItems === 'number' ? Math.max(1, schema.minItems) : 1;
      const maxItems =
        typeof schema.maxItems === 'number' ? Math.min(3, schema.maxItems) : Math.max(minItems, 2);
      const count = Math.min(5, rng.int(minItems, Math.max(minItems, maxItems)));
      const itemSchema =
        schema.items && typeof schema.items === 'object'
          ? (schema.items as Record<string, unknown>)
          : { type: 'string' };
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) {
        out.push(generateNodeFromSchema(itemSchema, rng, `${fieldName}Item`, depth + 1));
      }
      return out;
    }
    case 'object':
    default: {
      const out: Record<string, unknown> = {};
      const props =
        schema.properties && typeof schema.properties === 'object'
          ? (schema.properties as Record<string, Record<string, unknown>>)
          : {};
      const requiredSet = new Set(
        Array.isArray(schema.required) ? schema.required.map(String) : [],
      );
      for (const [key, propSchema] of Object.entries(props)) {
        if (requiredSet.has(key) || rng.next() >= 0.1) {
          if (propSchema && typeof propSchema === 'object') {
            out[key] = generateNodeFromSchema(propSchema, rng, key, depth + 1);
          }
        }
      }
      for (const reqKey of requiredSet) {
        if (!(reqKey in out)) {
          out[reqKey] = generateNodeFromSchema({ type: 'string' }, rng, reqKey, depth + 1);
        }
      }
      return out;
    }
  }
}

/** Deterministically generates synthetic JSON fixture event data from a JSON Schema using seeded PRNG. */
export function generateValueFromSchema(
  schema: Record<string, unknown> | undefined,
  seed = 42,
): unknown {
  if (!schema || Object.keys(schema).length === 0) {
    return { id: createSeededPrng(seed).uuid(), message: 'sample payload' };
  }
  const rng = createSeededPrng(hashSeedParts(seed, JSON.stringify(schema).length));
  return generateNodeFromSchema(schema, rng, '', 0);
}

/** Validates a fixture's `event` payload against its attached JSON Schema (if provided). */
export function validateFixtureEvent(fixture: PayloadFixture): SchemaValidationResult {
  if (!fixture.schema) {
    return { valid: true, errors: [] };
  }
  return validateJsonSchemaValue(fixture.schema, fixture.event);
}

export interface RunFixtureSuiteInput {
  script: ScriptAsset;
  fixtures: readonly PayloadFixture[];
  designScripts?: readonly ScriptAsset[];
  design?: Design;
  node?: NodeInstance;
  service?: ServiceDefinition;
  customServices?: readonly ServiceDefinition[];
  seed?: number;
  env?: Record<string, string>;
  limits?: Partial<SandboxLimits>;
  mockResolver?: MockCallResolver;
  quickJsWasmUrl?: string;
  esbuildWasmUrl?: string;
}

/** Executes a handler script against every fixture in a test suite and checks expected HTTP status / non-throwing behavior. */
export async function runFixtureSuite(input: RunFixtureSuiteInput): Promise<FixtureSuiteReport> {
  const baseSeed = input.seed ?? input.design?.settings.seed ?? 42;
  const results: FixtureSuiteItemResult[] = [];
  let passedCount = 0;

  for (let i = 0; i < input.fixtures.length; i++) {
    const fixture = input.fixtures[i]!;
    const dryRunResult = await executeInSandbox({
      script: input.script,
      fixture,
      seed: baseSeed + i,
      seq: i + 1,
      ...(input.designScripts ? { designScripts: input.designScripts } : {}),
      ...(input.design ? { design: input.design } : {}),
      ...(input.node ? { node: input.node } : {}),
      ...(input.service ? { service: input.service } : {}),
      ...(input.customServices ? { customServices: input.customServices } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
      ...(input.mockResolver ? { mockResolver: input.mockResolver } : {}),
      ...(input.quickJsWasmUrl ? { quickJsWasmUrl: input.quickJsWasmUrl } : {}),
      ...(input.esbuildWasmUrl ? { esbuildWasmUrl: input.esbuildWasmUrl } : {}),
    });

    const actualStatus = dryRunResult.httpStatus;
    let passed = dryRunResult.ok;
    let reason: string | undefined;

    if (!dryRunResult.ok) {
      reason = dryRunResult.error
        ? `${dryRunResult.error.name}: ${dryRunResult.error.message}`
        : 'Invocation failed';
    } else if (fixture.expectedStatus !== undefined) {
      if (actualStatus === undefined) {
        passed = false;
        reason = `Expected HTTP status ${fixture.expectedStatus} but handler returned no statusCode`;
      } else if (actualStatus !== fixture.expectedStatus) {
        passed = false;
        reason = `Expected status ${fixture.expectedStatus}, got ${actualStatus}`;
      }
    }

    if (passed) {
      passedCount += 1;
    }

    results.push({
      fixtureId: fixture.id,
      fixtureName: fixture.name,
      passed,
      ...(reason ? { reason } : {}),
      ...(fixture.expectedStatus !== undefined ? { expectedStatus: fixture.expectedStatus } : {}),
      ...(actualStatus !== undefined ? { actualStatus } : {}),
      virtualDurationMs: dryRunResult.virtualDurationMs,
      dryRunResult,
    });
  }

  return {
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    results,
  };
}
