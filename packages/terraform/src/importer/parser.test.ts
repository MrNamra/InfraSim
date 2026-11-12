import { describe, expect, it } from 'vitest';
import { classifyTerraformResources } from './classifier.js';
import { extractResourceAddressFromRef, flattenTerraformModules } from './parser.js';
import { parseAndSanitizeTerraformJson } from './sanitizer.js';

describe('@infrasim/terraform plan/state parser, sanitizer & classifier (T5.3)', () => {
  it('enforces the 5 MB input size limit and validates format_version & root_module', () => {
    const oversized = JSON.stringify({
      format_version: '1.2',
      planned_values: { root_module: { resources: [] } },
    });
    expect(() => parseAndSanitizeTerraformJson(oversized, 32)).toThrow(/safety limit/i);
    expect(() => parseAndSanitizeTerraformJson('{}')).toThrow(/format_version/i);
    expect(() => parseAndSanitizeTerraformJson(JSON.stringify({ format_version: '1.2' }))).toThrow(
      /root_module/i,
    );
  });

  it('strips sensitive_values masks and all deny-listed secret keys deeply without leaking literals', () => {
    const syntheticPemMarker = `${['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')}abc`;
    const planJson = {
      format_version: '1.2',
      planned_values: {
        root_module: {
          resources: [
            {
              address: 'aws_db_instance.orders',
              mode: 'managed',
              type: 'aws_db_instance',
              name: 'orders',
              provider_name: 'registry.terraform.io/hashicorp/aws',
              values: {
                engine: 'postgres',
                instance_class: 'db.t3.medium',
                allocated_storage: 100,
                username: 'appadmin',
                password: 'SUPER_SECRET_DB_PASSWORD',
                nested_credentials: {
                  private_key: syntheticPemMarker,
                  access_key: 'AKIAFAKEKEY123456',
                  safe_region: 'us-east-1',
                },
                flagged_custom_field: 'MUST_BE_STRIPPED_BY_SENSITIVE_MASK',
              },
              sensitive_values: {
                password: true,
                flagged_custom_field: true,
                nested_credentials: {
                  private_key: true,
                },
              },
            },
            {
              address: 'google_cloud_run_v2_service.api',
              mode: 'managed',
              type: 'google_cloud_run_v2_service',
              name: 'api',
              provider_name: 'registry.terraform.io/hashicorp/google',
              values: {
                location: 'us-central1',
                template: [
                  {
                    containers: [
                      {
                        env: [
                          { name: 'LOG_LEVEL', value: 'info' },
                          { name: 'API_TOKEN', value: 'ghp_SUPER_SECRET_TOKEN_99' },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      configuration: {
        root_module: {
          resources: [
            {
              address: 'aws_db_instance.orders',
              expressions: {
                vpc_security_group_ids: { references: ['aws_security_group.db.id'] },
                password: { constant_value: 'SHOULD_NOT_SURVIVE' },
              },
            },
          ],
        },
      },
    };

    const sanitized = parseAndSanitizeTerraformJson(JSON.stringify(planJson));
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain('SUPER_SECRET_DB_PASSWORD');
    expect(serialized).not.toContain(syntheticPemMarker);
    expect(serialized).not.toContain('AKIAFAKEKEY123456');
    expect(serialized).not.toContain('MUST_BE_STRIPPED_BY_SENSITIVE_MASK');
    expect(serialized).not.toContain('ghp_SUPER_SECRET_TOKEN_99');
    expect(serialized).not.toContain('SHOULD_NOT_SURVIVE');
    expect(sanitized.strippedSensitiveCount).toBeGreaterThanOrEqual(5);
    expect(sanitized.providersDetected).toEqual(['aws', 'gcp']);

    const flattened = flattenTerraformModules(sanitized);
    const classified = classifyTerraformResources(flattened);
    const runNode = classified.find((c) => c.resource.type === 'google_cloud_run_v2_service');
    expect(runNode?.nodeConfig?.mockEnv).toEqual({ LOG_LEVEL: 'info' });
  });

  it('flattens nested child_modules, resolves module-local expression references, and accepts state JSON', () => {
    const stateJson = {
      format_version: '1.0',
      values: {
        root_module: {
          child_modules: [
            {
              address: 'module.network',
              resources: [
                {
                  address: 'module.network.aws_vpc.main',
                  mode: 'managed',
                  type: 'aws_vpc',
                  name: 'main',
                  provider_name: 'aws',
                  values: { cidr_block: '10.0.0.0/16', tags: { Name: 'Main VPC' } },
                },
              ],
              child_modules: [
                {
                  address: 'module.network.module.app',
                  resources: [
                    {
                      address: 'module.network.module.app.aws_instance.api',
                      mode: 'managed',
                      type: 'aws_instance',
                      name: 'api',
                      provider_name: 'aws',
                      values: { instance_type: 't3.small', tags: { Name: 'Orders API' } },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      configuration: {
        root_module: {
          module_calls: {
            network: {
              module: {
                module_calls: {
                  app: {
                    module: {
                      resources: [
                        {
                          address: 'aws_instance.api',
                          expressions: {
                            subnet_id: { references: ['aws_subnet.priv.id'] },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const sanitized = parseAndSanitizeTerraformJson(stateJson);
    expect(sanitized.sourceKind).toBe('state');

    const resources = flattenTerraformModules(sanitized);
    expect(resources).toHaveLength(2);
    const api = resources.find((r) => r.address === 'module.network.module.app.aws_instance.api')!;
    expect(api.moduleAddress).toBe('module.network.module.app');
    expect(api.referencesByAttr.subnet_id).toEqual([
      'module.network.module.app.aws_subnet.priv.id',
    ]);
    expect(
      extractResourceAddressFromRef(api.referencesByAttr.subnet_id![0]!, api.moduleAddress),
    ).toBe('module.network.module.app.aws_subnet.priv');

    const classified = classifyTerraformResources(resources);
    const apiClass = classified.find((c) => c.serviceId === 'aws.ec2')!;
    expect(apiClass.classification).toBe('node');
    expect(apiClass.nodeConfig?.runtimePreset).toBe('custom');
    expect(apiClass.nodeConfig?.vcpu).toBe(2);
    expect(apiClass.nodeConfig?.memoryGb).toBe(2);
  });

  it('classifies AWS/GCP/Azure/OCI resources, flags unknown instance types, and retains unsupported types as gray nodes', () => {
    const planJson = {
      format_version: '1.2',
      planned_values: {
        root_module: {
          resources: [
            {
              address: 'aws_instance.custom_box',
              mode: 'managed',
              type: 'aws_instance',
              name: 'custom_box',
              provider_name: 'aws',
              values: { instance_type: 'z9x.mystery-metal' },
            },
            {
              address: 'oci_psql_db_system.pg',
              mode: 'managed',
              type: 'oci_psql_db_system',
              name: 'pg',
              provider_name: 'oci',
              values: {
                display_name: 'OCI PG',
                instance_ocpu_count: 2,
                instance_memory_size_in_gbs: 32,
              },
            },
            {
              address: 'azurerm_cognitive_deployment.llm',
              mode: 'managed',
              type: 'azurerm_cognitive_deployment',
              name: 'llm',
              provider_name: 'azurerm',
              values: { name: 'gpt-4o-mini' },
            },
            {
              address: 'aws_redshift_cluster.dwh',
              mode: 'managed',
              type: 'aws_redshift_cluster',
              name: 'dwh',
              provider_name: 'aws',
              values: { cluster_identifier: 'analytics-warehouse', node_type: 'ra3.xlplus' },
            },
            {
              address: 'data.aws_ssm_parameter.ami',
              mode: 'data',
              type: 'aws_ssm_parameter',
              name: 'ami',
              provider_name: 'aws',
              values: {
                name: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
              },
            },
          ],
        },
      },
    };

    const sanitized = parseAndSanitizeTerraformJson(planJson);
    const classified = classifyTerraformResources(flattenTerraformModules(sanitized));

    const ec2 = classified.find((c) => c.resource.name === 'custom_box')!;
    expect(ec2.classification).toBe('node');
    expect(ec2.unknownInstanceType?.instanceType).toBe('z9x.mystery-metal');

    const ociPg = classified.find((c) => c.resource.type === 'oci_psql_db_system')!;
    expect(ociPg.serviceId).toBe('oci.postgres');
    expect(ociPg.nodeConfig?.vcpu).toBe(4);
    expect(ociPg.nodeConfig?.memoryGb).toBe(32);

    const azureOpenAi = classified.find((c) => c.resource.type === 'azurerm_cognitive_deployment')!;
    expect(azureOpenAi.serviceId).toBe('azure.openai');
    expect(azureOpenAi.nodeConfig?.ai?.modelLabel).toBe('gpt-4o-mini');

    const unsupported = classified.find((c) => c.resource.type === 'aws_redshift_cluster')!;
    expect(unsupported.classification).toBe('unsupported');
    expect(unsupported.serviceId).toBe('custom.tf_aws_redshift_cluster');
    expect(unsupported.importedAttrs.cluster_identifier).toBe('analytics-warehouse');

    const dataAmi = classified.find((c) => c.resource.mode === 'data')!;
    expect(dataAmi.classification).toBe('ignored');
  });
});
