import { describe, expect, it } from 'vitest';
import { getService } from '@infrasim/catalog';
import {
  buildCustomServiceDefinition,
  createCustomServiceDraft,
  mergeCustomServices,
  slugifyCustomServiceId,
  validateCustomServiceDraft,
} from './customServices';

describe('customServices helpers', () => {
  it('slugifies arbitrary names into valid custom.* identifiers', () => {
    expect(slugifyCustomServiceId('Stripe Billing API v2')).toBe('custom.stripe_billing_api_v2');
    expect(slugifyCustomServiceId('   ')).toBe('custom.service_block');
    expect(slugifyCustomServiceId('A')).toBe('custom.a_svc');
  });

  it('merges custom service lists preserving earliest occurrences without duplicates', () => {
    const first = buildCustomServiceDefinition({
      ...createCustomServiceDraft(),
      id: 'custom.alpha',
      name: 'Alpha Design',
    });
    const duplicate = buildCustomServiceDefinition({
      ...createCustomServiceDraft(),
      id: 'custom.alpha',
      name: 'Alpha Library',
    });
    const second = buildCustomServiceDefinition({
      ...createCustomServiceDraft(),
      id: 'custom.beta',
      name: 'Beta',
    });

    const merged = mergeCustomServices([first], [duplicate, second]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.name).toBe('Alpha Design');
    expect(merged[1]?.id).toBe('custom.beta');
  });

  it('duplicates an existing AWS catalog service and preserves manual pricing and secondary ops', () => {
    const s3 = getService('aws.s3');
    expect(s3).toBeDefined();

    const draft = createCustomServiceDraft(s3, 'duplicate');
    draft.manualUnitPrice = '12.5';
    draft.manualUnit = 'month';
    draft.color = '#10b981';

    const validation = validateCustomServiceDraft(draft, []);
    expect(validation.valid).toBe(true);

    const def = buildCustomServiceDefinition(draft, s3);
    expect(def.id).toBe(slugifyCustomServiceId(`Custom ${s3!.name}`));
    expect(def.provider).toBe('custom');
    expect(def.kind).toBe('object');
    expect(def.manualUnitPrice).toBe(12.5);
    expect(def.manualUnit).toBe('month');
    expect(def.color).toBe('#10b981');
    expect(def.operations.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid custom IDs, p95 < p50, duplicate IDs, and broken template syntax', () => {
    const draft = createCustomServiceDraft();
    draft.id = 'aws.ec2';
    draft.p50 = '120';
    draft.p95 = '40';
    draft.bodyTemplate = '{"bad": {{unknown.helper}}}';

    const check = validateCustomServiceDraft(draft, ['custom.existing']);
    expect(check.valid).toBe(false);
    expect(check.errors.id).toBeTruthy();
    expect(check.errors.p95).toBeTruthy();
    expect(check.errors.bodyTemplate).toBeTruthy();

    const collisionDraft = createCustomServiceDraft();
    collisionDraft.id = 'custom.existing';
    expect(validateCustomServiceDraft(collisionDraft, ['custom.existing']).valid).toBe(false);
    expect(
      validateCustomServiceDraft(collisionDraft, ['custom.existing'], 'custom.existing').valid,
    ).toBe(true);
  });
});
