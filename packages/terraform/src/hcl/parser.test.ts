import { describe, expect, it } from 'vitest';
import { createEmptyDesign } from '@infrasim/shared-types';
import { parseHclDocument, syncTerraformHclToDesign } from './parser.js';

describe('Terraform HCL Parser & Bidirectional Sync', () => {
  it('parses structured HCL document blocks and attributes', () => {
    const hcl = `
resource "aws_instance" "api" {
  instance_type = "t3.medium"
  ami           = "ami-12345678"
  tags = {
    Name = "Checkout API Server"
  }
}
    `.trim();

    const doc = parseHclDocument(hcl, 'compute.tf');
    expect(doc.valid).toBe(true);
    expect(doc.errors).toEqual([]);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.type).toBe('resource');
    expect(doc.blocks[0]?.labels).toEqual(['aws_instance', 'api']);
    expect(doc.blocks[0]?.attributes.instance_type).toBe('t3.medium');
  });

  it('rejects malformed HCL with clear syntax error and line numbers without altering design', () => {
    const invalidHcl = `
resource "aws_instance" "api" {
  instance_type = "t3.medium"
  # Missing closing brace
    `.trim();

    const baseDesign = createEmptyDesign('Test Design');
    baseDesign.nodes.push({
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'Original API',
      position: { x: 100, y: 100 },
      config: { instances: 1, instanceType: 't3.micro', operations: {} },
    });

    const res = syncTerraformHclToDesign(baseDesign, invalidHcl, 'compute.tf');
    expect(res.changed).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    // Design remains completely unchanged!
    expect(res.design.nodes[0]?.label).toBe('Original API');
    expect(res.design.nodes[0]?.config.instanceType).toBe('t3.micro');
  });

  it('synchronizes edited node labels and configs from valid HCL into the Design', () => {
    const validHcl = `
resource "aws_instance" "api" {
  instance_type = "t3.2xlarge"
  tags = {
    Name = "Updated Production API"
  }
}
    `.trim();

    const baseDesign = createEmptyDesign('Test Design');
    baseDesign.nodes.push({
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'Old API',
      position: { x: 100, y: 100 },
      config: { instances: 1, instanceType: 't3.micro', operations: {} },
    });

    const res = syncTerraformHclToDesign(baseDesign, validHcl, 'compute.tf');
    expect(res.changed).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.design.nodes[0]?.label).toBe('Updated Production API');
    expect(res.design.nodes[0]?.config.instanceType).toBe('t3.2xlarge');
  });

  it('adds newly defined resources in HCL as new nodes on the canvas', () => {
    const hclWithNewService = `
resource "aws_sqs_queue" "orders_queue" {
  name = "orders-pipeline"
}
    `.trim();

    const baseDesign = createEmptyDesign('Test Design');
    baseDesign.nodes.push({
      id: 'web',
      serviceId: 'aws.ec2',
      label: 'Web Server',
      position: { x: 100, y: 100 },
      config: { instances: 1, operations: {} },
    });

    const res = syncTerraformHclToDesign(baseDesign, hclWithNewService, 'compute.tf');
    expect(res.changed).toBe(true);
    expect(res.design.nodes).toHaveLength(2);
    const sqsNode = res.design.nodes.find((n) => n.serviceId === 'aws.sqs');
    expect(sqsNode).toBeDefined();
    expect(sqsNode?.label).toContain('orders');
  });
});
