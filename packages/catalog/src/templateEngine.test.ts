import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { getCatalog } from './index.js';
import { validateJsonSchemaDefinition, validateJsonSchemaValue } from './schemaValidator.js';
import {
  MAX_TEMPLATE_OUTPUT_BYTES,
  evaluateResponseTemplate,
  renderMockOperationPreview,
  validateResponseTemplate,
} from './templateEngine.js';

describe('T2.2 seeded template engine and JSON Schema validator', () => {
  it('validates and renders every default catalog operation bodyTemplate cleanly', () => {
    const services = getCatalog();
    for (const service of services) {
      for (const op of service.operations) {
        const valid = validateResponseTemplate(op.defaultResponse.bodyTemplate);
        expect(valid.valid, `${service.id}.${op.name}: ${valid.error?.message}`).toBe(true);

        const preview = renderMockOperationPreview(op, undefined, {
          seed: 42,
          seq: 7,
          nowMs: 12500,
          input: { id: 'req-123', user: { name: 'Alice' } },
          env: { ENV_NAME: 'staging' },
        });
        expect(preview.statusCode).toBe(op.defaultResponse.statusCode);
        expect(Number.isFinite(preview.byteLength)).toBe(true);
      }
    }
  });

  it('supports all expressions from spec 06 §4 deterministically', () => {
    const tpl =
      '{"user":"{{input.user.name}}","env":"{{env.STAGE}}","seq":{{seq}},"now":{{now}},"iso":"{{now.iso}}","id":"{{faker.uuid}}","name":"{{faker.name}}","email":"{{faker.email}}","num":{{faker.int(10,20)}},"hex":"{{faker.hex(8)}}","pick":"{{faker.pick("blue","green")}}","echo":{{json(input.user)}},"text":"{{tokens(3)}}","rows":[{{repeat(2,"{\\"k\\":{{faker.int(1,5)}}}")}}],"bin":"{{binary(20480)}}"}';

    const validation = validateResponseTemplate(tpl);
    expect(validation.valid).toBe(true);

    const ctx = {
      input: { user: { name: 'Avery', role: 'admin' } },
      env: { STAGE: 'prod' },
      seq: 11,
      nowMs: 5000,
      seed: 99,
    };

    const a = evaluateResponseTemplate(tpl, ctx);
    const b = evaluateResponseTemplate(tpl, ctx);
    expect(a).toEqual(b);

    const parsed = JSON.parse(a.body) as Record<string, unknown>;
    expect(parsed.user).toBe('Avery');
    expect(parsed.env).toBe('prod');
    expect(parsed.seq).toBe(11);
    expect(parsed.now).toBe(5000);
    expect(typeof parsed.iso).toBe('string');
    expect(String(parsed.iso)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(String(parsed.id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(parsed.email)).toContain('@example.test');
    expect(parsed.num).toBeGreaterThanOrEqual(10);
    expect(parsed.num).toBeLessThanOrEqual(20);
    expect(['blue', 'green']).toContain(parsed.pick);
    expect(parsed.echo).toEqual({ name: 'Avery', role: 'admin' });
    expect((parsed.rows as unknown[]).length).toBe(2);
    expect(a.byteLength).toBeGreaterThanOrEqual(20480);
  });

  it('reports precise line and column diagnostics for malformed templates', () => {
    const unclosed = '{\n  "ok": {{faker.uuid\n}';
    const res1 = validateResponseTemplate(unclosed);
    expect(res1.valid).toBe(false);
    expect(res1.error?.line).toBe(2);
    expect(res1.error?.column).toBe(9);

    const unknownFn = '{"x": {{does.notExist()}}}';
    const res2 = validateResponseTemplate(unknownFn);
    expect(res2.valid).toBe(false);
    expect(res2.error?.line).toBe(1);
    expect(res2.error?.column).toBe(7);

    const badRange = '{"x": {{faker.int(20, 10)}}}';
    const res3 = validateResponseTemplate(badRange);
    expect(res3.valid).toBe(false);
    expect(res3.error?.line).toBe(1);
  });

  it('enforces the 1 MB rendered output limit', () => {
    const huge = `{"data":[${'{{repeat(5000,"{\\"payload\\":\\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\"}")}}'}]}`;
    expect(() => evaluateResponseTemplate(huge, { seed: 1 })).toThrow(/1 MB limit/i);
  });

  it('satisfies fast-check determinism and bounds invariants', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 50 }),
        fc.string({ minLength: 1, maxLength: 24 }),
        (seed, seq, label) => {
          const tpl =
            '{"seq":{{seq}},"label":"{{input.label}}","id":"{{faker.uuid}}","text":"{{tokens(5)}}"}';
          const out1 = evaluateResponseTemplate(tpl, { seed, seq, input: { label } });
          const out2 = evaluateResponseTemplate(tpl, { seed, seq, input: { label } });
          expect(out1).toEqual(out2);
          expect(out1.byteLength).toBeLessThanOrEqual(MAX_TEMPLATE_OUTPUT_BYTES);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('validates JSON schemas and sample payloads cleanly', () => {
    const schema = {
      type: 'object',
      required: ['orderId', 'amount'],
      additionalProperties: false,
      properties: {
        orderId: { type: 'string', minLength: 3 },
        amount: { type: 'number', minimum: 1 },
      },
    };
    expect(validateJsonSchemaDefinition(schema).valid).toBe(true);
    expect(validateJsonSchemaValue(schema, { orderId: 'ord-1', amount: 42 }).valid).toBe(true);

    const invalidPayload = validateJsonSchemaValue(schema, {
      orderId: 'x',
      amount: -5,
      extra: true,
    });
    expect(invalidPayload.valid).toBe(false);
    expect(invalidPayload.errors.length).toBeGreaterThanOrEqual(3);
  });
});
