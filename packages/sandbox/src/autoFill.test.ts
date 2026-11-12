import { describe, expect, it } from 'vitest';
import type { Design, ScriptAsset } from '@infrasim/shared-types';
import {
  buildResponseTemplateFromPaths,
  generateAutoFillPatches,
  inferFieldTemplateValue,
} from './autoFill.js';
import { executeInSandbox } from './runtime.js';
import { createFixtureFromTemplate } from './fixtures.js';

function makeDdbDesign(emptyMockTemplate = '{}'): Design {
  return {
    schemaVersion: 1,
    id: 'design-autofill',
    name: 'Auto-fill test',
    groups: [],
    network: {},
    nodes: [
      {
        id: 'lambda-1',
        serviceId: 'aws.lambda',
        label: 'API Handler',
        position: { x: 100, y: 100 },
        config: {
          instances: 1,
          scriptId: 'script-1',
          operations: {},
        },
      },
      {
        id: 'ddb-1',
        serviceId: 'aws.dynamodb',
        label: 'UsersTable',
        position: { x: 350, y: 100 },
        config: {
          instances: 1,
          operations: {
            GetItem: {
              responseTemplate: emptyMockTemplate,
            },
          },
        },
      },
    ],
    edges: [
      {
        id: 'e1',
        from: 'lambda-1',
        to: 'ddb-1',
        protocol: 'https',
        port: 443,
        callType: 'sync',
        weight: 1,
      },
    ],
    scenarios: [],
    scripts: [],
    fixtures: [],
    settings: {
      seed: 42,
      primaryProvider: 'aws',
      currency: 'USD',
      includeFreeTier: false,
    },
  };
}

describe('Auto-fill field inference and non-destructive template builder', () => {
  it('infers seeded template placeholders for field name conventions (§6.2)', () => {
    expect(inferFieldTemplateValue('userId')).toEqual({
      kind: 'literal',
      value: '{{faker.uuid}}',
    });
    expect(inferFieldTemplateValue('order_id')).toEqual({
      kind: 'literal',
      value: '{{faker.uuid}}',
    });
    expect(inferFieldTemplateValue('contactEmail')).toEqual({
      kind: 'literal',
      value: '{{faker.email}}',
    });
    expect(inferFieldTemplateValue('displayName')).toEqual({
      kind: 'literal',
      value: '{{faker.name}}',
    });
    expect(inferFieldTemplateValue('itemCount')).toEqual({
      kind: 'raw',
      expr: '{{faker.int(1,100)}}',
    });
    expect(inferFieldTemplateValue('totalPrice')).toEqual({
      kind: 'raw',
      expr: '{{faker.int(10,99)}}.{{faker.int(10,99)}}',
    });
    expect(inferFieldTemplateValue('isActive')).toEqual({
      kind: 'literal',
      value: true,
    });
    expect(inferFieldTemplateValue('createdAt')).toEqual({
      kind: 'literal',
      value: '{{now.iso}}',
    });
  });

  it('merges missing paths non-destructively into templates containing repeat() helpers', () => {
    const unquotedExisting = `{"status":"ok","Items":[{{repeat(3, "{\\"id\\":\\"{{faker.uuid}}\\"}")}}]}`;
    const updated = buildResponseTemplateFromPaths(
      ['Items[0].price', 'totalCount', 'meta.createdAt'],
      unquotedExisting,
    );

    expect(updated).toContain('"status": "ok"');
    expect(updated).toContain('repeat(3,');
    expect(updated).toContain('price');
    expect(updated).toContain('"totalCount": {{faker.int(1,100)}}');
    expect(updated).toContain('"createdAt": "{{now.iso}}"');
  });
});

describe('Acceptance Test #4: Auto-fill mocks discovers missing DynamoDB fields and fixes TypeError', () => {
  it('detects Item.userId from empty DynamoDB mock and passes re-run after patching', async () => {
    const design = makeDdbDesign('{}');
    const script: ScriptAsset = {
      id: 'script-1',
      name: 'handler.ts',
      kind: 'handler',
      language: 'typescript',
      entry: 'handler',
      source: `
        import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
        import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
        export async function handler(event: Record<string, any>) {
          const res = await ddb.send(new GetCommand({ TableName: 'Users', Key: { id: 'u1' } }));
          return {
            statusCode: 200,
            userId: res.Item.userId,
            email: res.Item.email,
          };
        }
      `,
      memoryMb: 128,
      timeoutMs: 3000,
      env: {},
    };
    const fixture = createFixtureFromTemplate('aws.apigw.proxy.v1');

    // Step 1: initial run fails with TypeError because mock returns {}
    const initialRun = await executeInSandbox({
      script,
      design,
      node: design.nodes[0],
      fixture,
      seed: 42,
    });
    expect(initialRun.ok).toBe(false);
    expect(initialRun.error?.name).toBe('TypeError');
    expect(initialRun.error?.message).toMatch(/userId/i);

    // Step 2: run Auto-fill discovery
    const discovery = await generateAutoFillPatches({
      script,
      design,
      node: design.nodes[0],
      fixture,
      seed: 42,
    });
    expect(discovery.patches).toHaveLength(1);
    const patch = discovery.patches[0]!;
    expect(patch.serviceId).toBe('aws.dynamodb');
    expect(patch.op).toBe('GetItem');
    expect(patch.targetNodeId).toBe('ddb-1');
    expect(patch.beforeTemplate).toBe('{}');
    expect(patch.accessedPaths).toContain('Item.userId');
    expect(patch.accessedPaths).toContain('Item.email');

    // Step 3: apply patch to DynamoDB node mock and re-run
    const patchedDesign = structuredClone(design);
    patchedDesign.nodes[1]!.config.operations.GetItem!.responseTemplate = patch.afterTemplate;

    const fixedRun = await executeInSandbox({
      script,
      design: patchedDesign,
      node: patchedDesign.nodes[0],
      fixture,
      seed: 42,
    });
    expect(fixedRun.ok).toBe(true);
    const out = fixedRun.result as { statusCode: number; userId: string; email: string };
    expect(out.statusCode).toBe(200);
    expect(out.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(out.email).toContain('@');
  });
});
