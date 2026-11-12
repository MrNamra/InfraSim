import { afterAll, describe, expect, it } from 'vitest';
import type { NodeInstance, ScriptAsset } from '@infrasim/shared-types';
import {
  attachProviderPlatformLogs,
  executeInSandbox,
  formatProviderPlatformLogs,
  stopSandboxBundler,
} from './index.js';

afterAll(async () => {
  await stopSandboxBundler();
});

function makeNode(serviceId: string, label: string): NodeInstance {
  return {
    id: `node-${serviceId}`,
    serviceId,
    label,
    position: { x: 100, y: 100 },
    config: {
      instances: 1,
      operations: {},
    },
  };
}

function makeScript(source: string): ScriptAsset {
  return {
    id: 'script-plat',
    name: 'fn.ts',
    kind: 'handler',
    language: 'typescript',
    entry: 'handler',
    source,
    memoryMb: 512,
    timeoutMs: 3000,
    env: {},
  };
}

describe('T3.8 Provider platform log formatters (§9.2)', () => {
  it('formats AWS Lambda START/END/REPORT and includes Init Duration only on cold starts', () => {
    const warm = formatProviderPlatformLogs({
      serviceId: 'aws.lambda',
      nodeId: 'lambda-1',
      nodeLabel: 'OrdersFn',
      requestId: 'req-abc',
      durationMs: 42.1,
      billedDurationMs: 43,
      memoryMb: 512,
      memoryPeakBytes: 88 * 1024 * 1024,
      coldStart: false,
      initDurationMs: 231.5,
      ok: true,
    });
    expect(warm.startEntries[0]?.message).toBe('START RequestId: req-abc Version: $LATEST');
    expect(warm.endEntries[0]?.message).toBe('END RequestId: req-abc');
    expect(warm.endEntries[1]?.message).toBe(
      'REPORT RequestId: req-abc Duration: 42.10 ms Billed Duration: 43 ms Memory Size: 512 MB Max Memory Used: 88 MB',
    );
    expect(warm.endEntries[1]?.message).not.toContain('Init Duration');

    const cold = formatProviderPlatformLogs({
      serviceId: 'aws.lambda',
      nodeId: 'lambda-1',
      nodeLabel: 'OrdersFn',
      requestId: 'req-cold',
      durationMs: 42.1,
      billedDurationMs: 43,
      memoryMb: 512,
      memoryPeakBytes: 88 * 1024 * 1024,
      coldStart: true,
      initDurationMs: 231.5,
      ok: true,
    });
    expect(cold.endEntries[1]?.message).toContain('Init Duration: 231.5 ms');
  });

  it('formats GCP Cloud Run structured JSON, Azure Functions host lines, and OCI Functions stdout', () => {
    const gcp = formatProviderPlatformLogs({
      serviceId: 'gcp.cloud_run',
      requestId: 'req-gcp',
      durationMs: 42,
      method: 'GET',
      statusCode: 200,
      ok: true,
    });
    const parsedGcp = JSON.parse(gcp.endEntries[0]!.message) as {
      httpRequest: { requestMethod: string; status: number; latency: string };
      severity: string;
    };
    expect(parsedGcp.httpRequest).toEqual({
      requestMethod: 'GET',
      status: 200,
      latency: '0.042s',
    });
    expect(parsedGcp.severity).toBe('INFO');

    const azure = formatProviderPlatformLogs({
      serviceId: 'azure.functions',
      nodeLabel: 'api',
      requestId: 'req-az',
      durationMs: 42,
      ok: true,
    });
    expect(azure.startEntries[0]?.message).toContain("Executing 'Functions.api'");
    expect(azure.startEntries[0]?.message).toContain('Id=req-az');
    expect(azure.endEntries[0]?.message).toContain(
      "Executed 'Functions.api' (Succeeded, Id=req-az, Duration=42ms)",
    );

    const oci = formatProviderPlatformLogs({
      serviceId: 'oci.functions',
      nodeLabel: 'worker',
      requestId: 'req-oci',
      durationMs: 18.5,
      ok: true,
    });
    expect(oci.startEntries[0]?.message).toContain('[req-oci] START');
    expect(oci.endEntries[0]?.message).toContain('[req-oci] DONE');
  });

  it('wraps executeInSandbox user logs with provider platform lines when a node is attached', async () => {
    const awsRes = await executeInSandbox({
      script: makeScript(`
        export function handler() {
          console.info('processing item');
          return { statusCode: 200, body: 'ok' };
        }
      `),
      node: makeNode('aws.lambda', 'CheckoutFn'),
      coldStart: true,
      initDurationMs: 195.4,
      seed: 42,
    });

    expect(awsRes.ok).toBe(true);
    expect(awsRes.logs[0]?.source).toBe('platform');
    expect(awsRes.logs[0]?.message).toMatch(/^START RequestId: .* Version: \$LATEST$/);
    expect(awsRes.logs.some((l) => l.source === 'user' && l.message === 'processing item')).toBe(
      true,
    );
    const report = awsRes.logs.find((l) => l.message.startsWith('REPORT RequestId:'));
    expect(report?.message).toContain('Init Duration: 195.4 ms');

    const gcpRes = await executeInSandbox({
      script: makeScript(`export function handler() { return { statusCode: 201 }; }`),
      node: makeNode('gcp.cloud_run', 'CatalogSvc'),
      event: { httpMethod: 'GET' },
      seed: 7,
    });
    const gcpPlatform = gcpRes.logs.find((l) => l.source === 'platform');
    expect(gcpPlatform).toBeDefined();
    expect(JSON.parse(gcpPlatform!.message).httpRequest.requestMethod).toBe('GET');

    // Also verify sequential log IDs via attachProviderPlatformLogs
    expect(awsRes.logs.map((l) => l.id)).toEqual(awsRes.logs.map((_, idx) => idx + 1));
    expect(attachProviderPlatformLogs).toBeDefined();
  });
});
