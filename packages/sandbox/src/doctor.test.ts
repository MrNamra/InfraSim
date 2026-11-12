import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ScriptAsset } from '@infrasim/shared-types';
import { analyzeDryRunDiagnostics } from './doctor.js';
import { PAYLOAD_DOCTOR_RULES } from './generated/payloadDoctorRules.js';
import { createFixtureFromTemplate } from './fixtures.js';
import type { DryRunResult, PayloadDoctorRule } from './types.js';

function makeBaseScript(source: string, overrides: Partial<ScriptAsset> = {}): ScriptAsset {
  return {
    id: 'script-1',
    name: 'handler.ts',
    kind: 'handler',
    language: 'typescript',
    entry: 'handler',
    source,
    memoryMb: 128,
    timeoutMs: 3000,
    env: {},
    ...overrides,
  };
}

function makeBaseResult(overrides: Partial<DryRunResult> = {}): DryRunResult {
  return {
    ok: true,
    seed: 42,
    virtualDurationMs: 12,
    billedDurationMs: 12,
    guestCpuMs: 2,
    memoryPeakBytes: 1024 * 1024,
    logs: [],
    calls: [],
    ...overrides,
  };
}

describe('Payload Doctor rules & JSON sync', () => {
  it('keeps generated TypeScript rules in exact sync with data/payload_doctor_rules.json', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const jsonPath = path.resolve(here, '../data/payload_doctor_rules.json');
    const jsonRules = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as PayloadDoctorRule[];
    expect(PAYLOAD_DOCTOR_RULES).toEqual(jsonRules);
    expect(PAYLOAD_DOCTOR_RULES).toHaveLength(12);
  });

  it('Acceptance Test #3: detects API Gateway stringified event.body and patches source cleanly', () => {
    const source = `
      export async function handler(event) {
        return { item: event.body.foo };
      }
    `;
    const event = createFixtureFromTemplate('aws.apigw.proxy.v1').event;
    const hints = analyzeDryRunDiagnostics({
      result: makeBaseResult(),
      script: makeBaseScript(source),
      event,
      templateId: 'aws.apigw.proxy.v1',
    });

    const rule = hints.find((h) => h.ruleId === 'apigw-body-string');
    expect(rule).toBeDefined();
    expect(rule?.actionKind).toBe('patch-source');
    expect(rule?.patchedSource).toContain('JSON.parse(event.body');

    const afterHints = analyzeDryRunDiagnostics({
      result: makeBaseResult(),
      script: makeBaseScript(rule!.patchedSource!),
      event,
      templateId: 'aws.apigw.proxy.v1',
    });
    expect(afterHints.some((h) => h.ruleId === 'apigw-body-string')).toBe(false);
  });

  it('detects all 12 cataloged Payload Doctor conditions accurately', () => {
    // 2. null-query-params
    const nullQp = analyzeDryRunDiagnostics({
      result: makeBaseResult({
        ok: false,
        error: {
          category: 'UserCodeError',
          name: 'TypeError',
          message: "Cannot read properties of null (reading 'id')",
        },
      }),
      script: makeBaseScript(
        'export function handler(event) { return event.queryStringParameters.id; }',
      ),
      event: { queryStringParameters: null },
    });
    expect(nullQp.some((h) => h.ruleId === 'null-query-params')).toBe(true);

    // 3. v2-http-method
    const v2 = analyzeDryRunDiagnostics({
      result: makeBaseResult(),
      script: makeBaseScript('export function handler(event) { return event.httpMethod; }'),
      event: createFixtureFromTemplate('aws.apigw.proxy.v2').event,
    });
    expect(v2.some((h) => h.ruleId === 'v2-http-method')).toBe(true);

    // 4. sqs-body-string
    const sqs = analyzeDryRunDiagnostics({
      result: makeBaseResult(),
      script: makeBaseScript(
        'export function handler(event) { return event.Records[0].body.orderId; }',
      ),
      event: createFixtureFromTemplate('aws.sqs').event,
    });
    expect(sqs.some((h) => h.ruleId === 'sqs-body-string')).toBe(true);

    // 5. s3-key-encoded
    const s3 = analyzeDryRunDiagnostics({
      result: makeBaseResult(),
      script: makeBaseScript(
        'export function handler(event) { return event.Records[0].s3.object.key; }',
      ),
      event: createFixtureFromTemplate('aws.s3.notification').event,
    });
    expect(s3.some((h) => h.ruleId === 's3-key-encoded')).toBe(true);

    // 6. base64-body
    const b64 = analyzeDryRunDiagnostics({
      result: makeBaseResult(),
      script: makeBaseScript('export function handler(event) { return event.body; }'),
      event: { isBase64Encoded: true, body: 'eyJvayI6dHJ1ZX0=' },
    });
    expect(b64.some((h) => h.ruleId === 'base64-body')).toBe(true);

    // 7. headers-case
    const hdr = analyzeDryRunDiagnostics({
      result: makeBaseResult(),
      script: makeBaseScript(
        'export function handler(event) { return event.headers.Authorization; }',
      ),
      event: { headers: { authorization: 'Bearer abc' } },
    });
    expect(hdr.some((h) => h.ruleId === 'headers-case')).toBe(true);

    // 8. missing-mock-field
    const missingMock = analyzeDryRunDiagnostics({
      result: makeBaseResult({
        ok: false,
        error: {
          category: 'UserCodeError',
          name: 'TypeError',
          message: "Cannot read properties of undefined (reading 'userId')",
        },
        calls: [
          {
            index: 0,
            serviceId: 'aws.dynamodb',
            op: 'GetItem',
            input: {},
            latencyMs: 5,
            startVirtualMs: 0,
            payloadBytes: 2,
            responseBytes: 2,
          },
        ],
      }),
      script: makeBaseScript('export function handler() {}'),
      event: {},
    });
    expect(missingMock.some((h) => h.ruleId === 'missing-mock-field')).toBe(true);

    // 9. missing-env
    const missingEnv = analyzeDryRunDiagnostics({
      result: makeBaseResult({
        ok: false,
        error: {
          category: 'UserCodeError',
          name: 'Error',
          message: 'Missing TABLE_NAME',
        },
      }),
      script: makeBaseScript('export function handler() { return process.env.TABLE_NAME; }'),
      event: {},
    });
    expect(missingEnv.some((h) => h.ruleId === 'missing-env' && h.envKey === 'TABLE_NAME')).toBe(
      true,
    );

    // 10. timeout-short
    const timeout = analyzeDryRunDiagnostics({
      result: makeBaseResult({
        ok: false,
        error: {
          category: 'Timeout',
          name: 'TimeoutError',
          message: 'Task timed out after 3.00 seconds',
        },
        calls: [
          {
            index: 0,
            serviceId: 'aws.rds_postgres',
            op: 'Query',
            input: {},
            latencyMs: 3200,
            startVirtualMs: 1,
            payloadBytes: 2,
            responseBytes: 2,
          },
        ],
      }),
      script: makeBaseScript('export function handler() {}', { timeoutMs: 3000 }),
      event: {},
    });
    expect(
      timeout.some((h) => h.ruleId === 'timeout-short' && h.actionKind === 'increase-timeout'),
    ).toBe(true);

    // 11. unhandled-rejection
    const rej = analyzeDryRunDiagnostics({
      result: makeBaseResult({
        ok: false,
        error: {
          category: 'UnhandledRejection',
          name: 'Error',
          message: 'boom',
        },
      }),
      script: makeBaseScript('export async function handler() {}'),
      event: {},
    });
    expect(rej.some((h) => h.ruleId === 'unhandled-rejection')).toBe(true);

    // 12. module-unavailable
    const mod = analyzeDryRunDiagnostics({
      result: makeBaseResult({
        ok: false,
        error: {
          category: 'UnsupportedModule',
          name: 'UnsupportedModuleError',
          message: "Module 'sharp' is not available.",
        },
      }),
      script: makeBaseScript("import sharp from 'sharp'; export function handler() {}"),
      event: {},
    });
    expect(mod.some((h) => h.ruleId === 'module-unavailable')).toBe(true);
  });

  it('supports adding a custom data-driven rule via JSON without changing engine code', () => {
    const customRule: PayloadDoctorRule = {
      id: 'custom-console-debug',
      title: 'Custom rule example',
      message: 'Custom match on timeout error: {{errorMessage}}',
      severity: 'info',
      matchCategories: ['Timeout'],
    };

    const hints = analyzeDryRunDiagnostics({
      rules: [customRule],
      result: makeBaseResult({
        ok: false,
        error: {
          category: 'Timeout',
          name: 'TimeoutError',
          message: 'timed out at 5000ms',
        },
      }),
      script: makeBaseScript('export function handler() {}'),
      event: {},
    });
    expect(hints).toHaveLength(1);
    expect(hints[0]?.ruleId).toBe('custom-console-debug');
    expect(hints[0]?.message).toContain('timed out at 5000ms');
  });
});
