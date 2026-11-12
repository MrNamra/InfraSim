import { afterAll, describe, expect, it } from 'vitest';
import type { FixtureTemplateId, ScriptAsset } from '@infrasim/shared-types';
import {
  FIXTURE_TEMPLATES,
  createFixtureFromTemplate,
  generateValueFromSchema,
  listFixtureTemplates,
  runFixtureSuite,
  stopSandboxBundler,
  validateFixtureEvent,
} from './index.js';

afterAll(async () => {
  await stopSandboxBundler();
});

const EXPECTED_TEMPLATE_IDS: FixtureTemplateId[] = [
  'aws.apigw.proxy.v1',
  'aws.apigw.proxy.v2',
  'aws.alb.target',
  'aws.sqs',
  'aws.sns',
  'aws.s3.notification',
  'aws.dynamodb.stream',
  'aws.eventbridge',
  'aws.kinesis',
  'gcp.http.request',
  'gcp.pubsub.push',
  'gcp.storage.event',
  'azure.http.trigger',
  'azure.queue.trigger',
  'azure.eventgrid',
  'oci.functions.http',
  'generic.json',
];

function makeHandlerScript(source: string): ScriptAsset {
  return {
    id: 'script-fixture-suite',
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

describe('T3.5 Fixture library, schema validation, seeded generator, and suite runner', () => {
  it('ships all 17 built-in provider event templates with valid default events matching their schemas', () => {
    const all = listFixtureTemplates();
    expect(all).toHaveLength(17);
    expect(FIXTURE_TEMPLATES.map((t) => t.id)).toEqual(EXPECTED_TEMPLATE_IDS);

    for (const id of EXPECTED_TEMPLATE_IDS) {
      const fixture = createFixtureFromTemplate(id);
      expect(fixture.template).toBe(id);
      const validation = validateFixtureEvent(fixture);
      expect(validation.valid).toBe(true);
    }
  });

  it('generates deterministic fake data from JSON Schema and validates against the same schema', () => {
    const schema = {
      type: 'object',
      required: ['orderId', 'email', 'quantity', 'tags'],
      properties: {
        orderId: { type: 'string', format: 'uuid' },
        email: { type: 'string', format: 'email' },
        quantity: { type: 'integer', minimum: 1, maximum: 20 },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: { type: 'string', enum: ['fast', 'vip', 'bulk'] },
        },
      },
    };

    const a = generateValueFromSchema(schema, 4242);
    const b = generateValueFromSchema(schema, 4242);
    const c = generateValueFromSchema(schema, 9999);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);

    const check = validateFixtureEvent({
      id: 'gen-1',
      name: 'Generated',
      event: a,
      schema,
    });
    expect(check.valid).toBe(true);

    const invalid = validateFixtureEvent({
      id: 'bad-1',
      name: 'Invalid',
      event: { orderId: '123' },
      schema,
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
  });

  it('runs a multi-fixture suite and checks expectedStatus vs handler output', async () => {
    const okFixture = createFixtureFromTemplate('aws.apigw.proxy.v1', {
      id: 'fix-ok',
      name: 'Valid POST order',
      expectedStatus: 200,
    });
    const badStatusFixture = createFixtureFromTemplate('aws.apigw.proxy.v1', {
      id: 'fix-400',
      name: 'Expects 400 on bad method',
      event: { httpMethod: 'DELETE', path: '/orders' },
      expectedStatus: 400,
    });
    const crashFixture = createFixtureFromTemplate('generic.json', {
      id: 'fix-crash',
      name: 'Unhandled error case',
      event: { crash: true },
    });

    const report = await runFixtureSuite({
      script: makeHandlerScript(`
        export async function handler(event: any) {
          if (event.crash) throw new Error('boom');
          if (event.httpMethod === 'DELETE') {
            return { statusCode: 405, body: 'Method not allowed' };
          }
          return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }
      `),
      fixtures: [okFixture, badStatusFixture, crashFixture],
    });

    expect(report.total).toBe(3);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(2);
    expect(report.results[0]?.passed).toBe(true);
    expect(report.results[1]?.passed).toBe(false);
    expect(report.results[1]?.reason).toContain('Expected status 400, got 405');
    expect(report.results[2]?.passed).toBe(false);
    expect(report.results[2]?.reason).toContain('boom');
  });
});
