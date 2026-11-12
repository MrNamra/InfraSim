import { describe, expect, it } from 'vitest';
import { importTerraformJson } from './index.js';

describe('@infrasim/terraform edge inference & full importer (T5.5)', () => {
  it('infers conservative edges from LB listeners, SG rules, env refs, and async subscriptions', async () => {
    const planJson = {
      format_version: '1.2',
      planned_values: {
        root_module: {
          resources: [
            {
              address: 'aws_vpc.main',
              mode: 'managed',
              type: 'aws_vpc',
              name: 'main',
              provider_name: 'aws',
              values: { cidr_block: '10.0.0.0/16' },
            },
            {
              address: 'aws_subnet.pub',
              mode: 'managed',
              type: 'aws_subnet',
              name: 'pub',
              provider_name: 'aws',
              values: { cidr_block: '10.0.1.0/24', map_public_ip_on_launch: true },
            },
            {
              address: 'aws_subnet.priv',
              mode: 'managed',
              type: 'aws_subnet',
              name: 'priv',
              provider_name: 'aws',
              values: { cidr_block: '10.0.10.0/24' },
            },
            {
              address: 'aws_security_group.alb_sg',
              mode: 'managed',
              type: 'aws_security_group',
              name: 'alb_sg',
              provider_name: 'aws',
              values: { name: 'alb-sg' },
            },
            {
              address: 'aws_security_group.api_sg',
              mode: 'managed',
              type: 'aws_security_group',
              name: 'api_sg',
              provider_name: 'aws',
              values: { name: 'api-sg' },
            },
            {
              address: 'aws_security_group.db_sg',
              mode: 'managed',
              type: 'aws_security_group',
              name: 'db_sg',
              provider_name: 'aws',
              values: { name: 'db-sg' },
            },
            {
              address: 'aws_vpc_security_group_ingress_rule.db_from_api',
              mode: 'managed',
              type: 'aws_vpc_security_group_ingress_rule',
              name: 'db_from_api',
              provider_name: 'aws',
              values: { ip_protocol: 'tcp', from_port: 5432, to_port: 5432 },
            },
            {
              address: 'aws_lb.edge',
              mode: 'managed',
              type: 'aws_lb',
              name: 'edge',
              provider_name: 'aws',
              values: { name: 'Edge ALB', load_balancer_type: 'application' },
            },
            {
              address: 'aws_lb_target_group.api_tg',
              mode: 'managed',
              type: 'aws_lb_target_group',
              name: 'api_tg',
              provider_name: 'aws',
              values: { port: 8080, protocol: 'HTTP' },
            },
            {
              address: 'aws_lb_listener.http',
              mode: 'managed',
              type: 'aws_lb_listener',
              name: 'http',
              provider_name: 'aws',
              values: { port: 443, protocol: 'HTTPS' },
            },
            {
              address: 'aws_lb_target_group_attachment.api_att',
              mode: 'managed',
              type: 'aws_lb_target_group_attachment',
              name: 'api_att',
              provider_name: 'aws',
              values: { port: 8080 },
            },
            {
              address: 'aws_instance.api',
              mode: 'managed',
              type: 'aws_instance',
              name: 'api',
              provider_name: 'aws',
              values: { instance_type: 't3.medium', tags: { Name: 'Orders API' } },
            },
            {
              address: 'aws_db_instance.pg',
              mode: 'managed',
              type: 'aws_db_instance',
              name: 'pg',
              provider_name: 'aws',
              values: {
                engine: 'postgres',
                instance_class: 'db.t3.small',
                tags: { Name: 'Orders DB' },
              },
            },
            {
              address: 'aws_sqs_queue.jobs',
              mode: 'managed',
              type: 'aws_sqs_queue',
              name: 'jobs',
              provider_name: 'aws',
              values: { name: 'Jobs Queue' },
            },
            {
              address: 'aws_lambda_function.worker',
              mode: 'managed',
              type: 'aws_lambda_function',
              name: 'worker',
              provider_name: 'aws',
              values: {
                function_name: 'Jobs Worker',
                memory_size: 512,
                environment: [{ variables: { TABLE_NAME: 'orders' } }],
              },
            },
            {
              address: 'aws_dynamodb_table.orders',
              mode: 'managed',
              type: 'aws_dynamodb_table',
              name: 'orders',
              provider_name: 'aws',
              values: { name: 'Orders Table' },
            },
            {
              address: 'aws_lambda_event_source_mapping.jobs_to_worker',
              mode: 'managed',
              type: 'aws_lambda_event_source_mapping',
              name: 'jobs_to_worker',
              provider_name: 'aws',
              values: { batch_size: 10 },
            },
          ],
        },
      },
      configuration: {
        root_module: {
          resources: [
            {
              address: 'aws_subnet.pub',
              expressions: { vpc_id: { references: ['aws_vpc.main.id'] } },
            },
            {
              address: 'aws_subnet.priv',
              expressions: { vpc_id: { references: ['aws_vpc.main.id'] } },
            },
            {
              address: 'aws_vpc_security_group_ingress_rule.db_from_api',
              expressions: {
                security_group_id: { references: ['aws_security_group.db_sg.id'] },
                referenced_security_group_id: { references: ['aws_security_group.api_sg.id'] },
              },
            },
            {
              address: 'aws_lb.edge',
              expressions: {
                subnets: { references: ['aws_subnet.pub.id'] },
                security_groups: { references: ['aws_security_group.alb_sg.id'] },
              },
            },
            {
              address: 'aws_lb_listener.http',
              expressions: {
                load_balancer_arn: { references: ['aws_lb.edge.arn'] },
                default_action: {
                  target_group_arn: { references: ['aws_lb_target_group.api_tg.arn'] },
                },
              },
            },
            {
              address: 'aws_lb_target_group_attachment.api_att',
              expressions: {
                target_group_arn: { references: ['aws_lb_target_group.api_tg.arn'] },
                target_id: { references: ['aws_instance.api.id'] },
              },
            },
            {
              address: 'aws_instance.api',
              expressions: {
                subnet_id: { references: ['aws_subnet.priv.id'] },
                vpc_security_group_ids: { references: ['aws_security_group.api_sg.id'] },
              },
            },
            {
              address: 'aws_db_instance.pg',
              expressions: {
                vpc_security_group_ids: { references: ['aws_security_group.db_sg.id'] },
              },
            },
            {
              address: 'aws_lambda_function.worker',
              expressions: {
                environment: {
                  variables: {
                    references: ['aws_dynamodb_table.orders.name'],
                  },
                },
              },
            },
            {
              address: 'aws_lambda_event_source_mapping.jobs_to_worker',
              expressions: {
                event_source_arn: { references: ['aws_sqs_queue.jobs.arn'] },
                function_name: { references: ['aws_lambda_function.worker.function_name'] },
              },
            },
          ],
        },
      },
    };

    const result = await importTerraformJson(planJson);
    const { design, report } = result;

    const findNode = (svcId: string) => design.nodes.find((n) => n.serviceId === svcId)!;
    const alb = findNode('aws.alb');
    const api = findNode('aws.ec2');
    const db = findNode('aws.rds_postgres');
    const sqs = findNode('aws.sqs');
    const fn = findNode('aws.lambda');
    const ddb = findNode('aws.dynamodb');

    const hasEdge = (from: string, to: string) =>
      design.edges.find((e) => e.from === from && e.to === to);

    const albToApi = hasEdge(alb.id, api.id);
    const apiToDb = hasEdge(api.id, db.id);
    const sqsToFn = hasEdge(sqs.id, fn.id);
    const fnToDdb = hasEdge(fn.id, ddb.id);

    expect(albToApi?.inferred).toBe(true);
    expect(apiToDb?.protocol).toBe('sql');
    expect(apiToDb?.port).toBe(5432);
    expect(sqsToFn?.callType).toBe('async');
    expect(fnToDdb?.callType).toBe('sync');

    expect(report.mappedCount).toBe(6);
    expect(report.groupCount).toBe(3);
    expect(report.needsRuntimePrompt).toBe(true);
    expect(report.inferredEdges).toHaveLength(4);
    expect(design.scenarios[0]?.entryNodeId).toBe(alb.id);
  });

  it('never invents edges between disconnected services lacking concrete wiring signals', async () => {
    const disconnectedPlan = {
      format_version: '1.2',
      planned_values: {
        root_module: {
          resources: [
            {
              address: 'aws_vpc.main',
              mode: 'managed',
              type: 'aws_vpc',
              name: 'main',
              provider_name: 'aws',
              values: { cidr_block: '10.0.0.0/16' },
            },
            {
              address: 'aws_subnet.priv',
              mode: 'managed',
              type: 'aws_subnet',
              name: 'priv',
              provider_name: 'aws',
              values: { cidr_block: '10.0.10.0/24' },
            },
            {
              address: 'aws_instance.app',
              mode: 'managed',
              type: 'aws_instance',
              name: 'app',
              provider_name: 'aws',
              values: { instance_type: 't3.micro' },
            },
            {
              address: 'aws_db_instance.pg',
              mode: 'managed',
              type: 'aws_db_instance',
              name: 'pg',
              provider_name: 'aws',
              values: { engine: 'postgres' },
            },
          ],
        },
      },
      configuration: {
        root_module: {
          resources: [
            {
              address: 'aws_subnet.priv',
              expressions: { vpc_id: { references: ['aws_vpc.main.id'] } },
            },
            {
              address: 'aws_instance.app',
              expressions: { subnet_id: { references: ['aws_subnet.priv.id'] } },
            },
            {
              address: 'aws_db_instance.pg',
              expressions: { db_subnet_group_name: { constant_value: 'priv' } },
            },
          ],
        },
      },
    };

    const result = await importTerraformJson(disconnectedPlan);
    expect(result.design.edges).toEqual([]);
    expect(result.report.inferredEdges).toEqual([]);
  });
});
