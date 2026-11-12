import { afterAll, describe, expect, it } from 'vitest';
import {
  createEmptyNetworkConfig,
  type Design,
  type NodeInstance,
  type ScriptAsset,
} from '@infrasim/shared-types';
import { executeInSandbox, stopSandboxBundler } from './index.js';

afterAll(async () => {
  await stopSandboxBundler();
});

function makeScript(source: string): ScriptAsset {
  return {
    id: 'script-mock-test',
    name: 'handler.ts',
    kind: 'handler',
    language: 'typescript',
    entry: 'handler',
    source,
    memoryMb: 128,
    timeoutMs: 3000,
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
      latency: { distribution: 'fixed', p50: 15, p95: 15 },
      operations: {},
      ...configOverrides,
    },
  };
}

function makeDesign(nodes: NodeInstance[], edges: Design['edges']): Design {
  return {
    schemaVersion: 1,
    id: 'd1',
    name: 'Mock Test Design',
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

describe('T3.3 Mock SDK universal cloud.call, HTTP interceptor, and error objects', () => {
  it('resolves cloud.call against catalog defaults in standalone dry run and validates inputSchema', async () => {
    const res = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          const item = await cloud.call('aws.dynamodb', 'GetItem', { TableName: 'users', Key: { id: '1' } });
          return item;
        }
      `),
      seed: 101,
    });

    expect(res.ok).toBe(true);
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0]?.serviceId).toBe('aws.dynamodb');
    expect(res.calls[0]?.op).toBe('GetItem');
    expect((res.result as { Item?: { id?: string } }).Item?.id).toBeTruthy();

    // Schema validation test on custom inputSchema
    const fnNode = makeNode('fn1', 'aws.lambda', 'Worker');
    const dbNode = makeNode('db1', 'aws.dynamodb', 'Orders', {
      operations: {
        GetItem: {
          inputSchema: {
            type: 'object',
            required: ['TableName'],
            properties: {
              TableName: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    });
    const design = makeDesign(
      [fnNode, dbNode],
      [
        {
          id: 'e1',
          from: 'fn1',
          to: 'db1',
          protocol: 'https',
          callType: 'sync',
          weight: 1,
        },
      ],
    );

    const invalid = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          return await cloud.call('aws.dynamodb', 'GetItem', {});
        }
      `),
      design,
      node: fnNode,
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.category).toBe('ValidationError');
    expect(invalid.error?.name).toBe('ValidationException');
    expect(invalid.error?.statusCode).toBe(400);
    expect(invalid.error?.message).toContain('TableName');
  });

  it('rejects missing outgoing edges with MockNotConfigured and verifies fetch("https://example.com") never touches network (Acceptance #8)', async () => {
    const fnNode = makeNode('fn1', 'aws.lambda', 'API Handler');
    const designNoDb = makeDesign([fnNode], []);

    const missingEdge = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          return await cloud.call('aws.dynamodb', 'GetItem', { Key: { id: '1' } });
        }
      `),
      design: designNoDb,
      node: fnNode,
    });
    expect(missingEdge.ok).toBe(false);
    expect(missingEdge.error?.category).toBe('MockNotConfigured');
    expect(missingEdge.error?.message).toBe(
      'No mock for aws.dynamodb. Add a service or edge to enable it.',
    );

    // Unmatched external URL must reject with MockNotConfigured and never perform any real fetch
    const externalFetch = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          const r = await fetch('https://example.com');
          return await r.text();
        }
      `),
    });
    expect(externalFetch.ok).toBe(false);
    expect(externalFetch.error?.category).toBe('MockNotConfigured');
    expect(externalFetch.error?.message).toBe(
      'No mock for https://example.com. Add a service or HTTP alias to enable it.',
    );
  });

  it('routes fetch/axios via HTTP host patterns and custom httpAliases', async () => {
    const fnNode = makeNode('fn1', 'aws.lambda', 'Worker');
    const s3Node = makeNode('s3', 'aws.s3', 'AssetsBucket', {
      latency: { distribution: 'fixed', p50: 40, p95: 40 },
      httpAliases: { 'https://payments.internal/*': 'GetObject' },
    });
    const design = makeDesign(
      [fnNode, s3Node],
      [{ id: 'e1', from: 'fn1', to: 's3', protocol: 'https', callType: 'sync', weight: 1 }],
    );

    const res = await executeInSandbox({
      script: makeScript(`
        import axios from 'axios';
        export async function handler() {
          const s3Resp = await fetch('https://my-bucket.s3.us-east-1.amazonaws.com/logo.png');
          const payResp = await axios.get('https://payments.internal/v1/charge/123');
          return {
            s3Status: s3Resp.status,
            payStatus: payResp.status,
            payETag: payResp.data?.ETag,
          };
        }
      `),
      design,
      node: fnNode,
    });

    expect(res.ok).toBe(true);
    expect(res.calls).toHaveLength(2);
    expect(res.calls[0]?.targetNodeId).toBe('s3');
    expect(res.calls[1]?.targetNodeId).toBe('s3');
    expect(res.virtualDurationMs).toBe(80);
    expect((res.result as { s3Status: number; payStatus: number }).s3Status).toBe(200);
    expect((res.result as { payStatus: number }).payStatus).toBe(200);
  });

  it('throws provider-shaped ThrottlingException with $metadata.httpStatusCode === 429 on throttle rate 1.0 (Acceptance #6)', async () => {
    const fnNode = makeNode('fn1', 'aws.lambda', 'Worker');
    const dbNode = makeNode('db1', 'aws.dynamodb', 'ThrottledDB', {
      operations: {
        GetItem: {
          errorRate: 1.0,
          errorKind: 'throttle',
          latency: { distribution: 'fixed', p50: 10, p95: 10 },
        },
      },
    });
    const design = makeDesign(
      [fnNode, dbNode],
      [{ id: 'e1', from: 'fn1', to: 'db1', protocol: 'https', callType: 'sync', weight: 1 }],
    );

    const caughtRes = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          try {
            await cloud.call('aws.dynamodb', 'GetItem', { Key: { id: '1' } });
            return { caught: false };
          } catch (err) {
            return {
              caught: true,
              name: err.name,
              code: err.code,
              status: err.$metadata?.httpStatusCode,
              retryable: err.$retryable?.throttling,
            };
          }
        }
      `),
      design,
      node: fnNode,
    });

    expect(caughtRes.ok).toBe(true);
    expect(caughtRes.result).toEqual({
      caught: true,
      name: 'ThrottlingException',
      code: 'ThrottlingException',
      status: 429,
      retryable: true,
    });
  });

  it('enforces stateful virtual-time token bucket rate limits across calls', async () => {
    const fnNode = makeNode('fn1', 'aws.lambda', 'Worker');
    const apiNode = makeNode('ext1', 'aws.lambda', 'DownstreamFn', {
      rateLimit: { rps: 1, burst: 2 },
      latency: { distribution: 'fixed', p50: 5, p95: 5 },
    });
    const design = makeDesign(
      [fnNode, apiNode],
      [{ id: 'e1', from: 'fn1', to: 'ext1', protocol: 'https', callType: 'sync', weight: 1 }],
    );

    const burstRes = await executeInSandbox({
      script: makeScript(`
        export async function handler() {
          const results = [];
          for (let i = 0; i < 3; i++) {
            try {
              await cloud.call('aws.lambda', 'Invoke', { n: i });
              results.push({ ok: true });
            } catch (err) {
              results.push({ ok: false, status: err.$metadata?.httpStatusCode, retryAfterMs: err.retryAfterMs });
            }
          }
          return results;
        }
      `),
      design,
      node: fnNode,
    });

    expect(burstRes.ok).toBe(true);
    const arr = burstRes.result as { ok: boolean; status?: number }[];
    expect(arr[0]?.ok).toBe(true);
    expect(arr[1]?.ok).toBe(true);
    expect(arr[2]?.ok).toBe(false);
    expect(arr[2]?.status).toBe(429);
  });
});
