import { describe, expect, it } from 'vitest';
import {
  createEmptyDesign,
  createEmptyNetworkConfig,
  SCHEMA_VERSION,
  validateDesign,
  type Design,
} from './index.js';

describe('@infrasim/shared-types', () => {
  it('exports schema version 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('validates createEmptyDesign() against the generated JSON Schema', () => {
    const empty = createEmptyDesign();
    const res = validateDesign(empty);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('validates the tiny 3-tier example design from spec 04', () => {
    const tinyDesign: Design = {
      schemaVersion: 1,
      id: 'd1',
      name: 'Hello 3-tier',
      nodes: [
        {
          id: 'c',
          serviceId: 'generic.client',
          label: 'Users',
          position: { x: 0, y: 0 },
          config: { instances: 1, operations: {} },
        },
        {
          id: 'lb',
          serviceId: 'aws.alb',
          label: 'ALB',
          position: { x: 200, y: 0 },
          config: { instances: 1, operations: {} },
        },
        {
          id: 'app',
          serviceId: 'aws.ec2',
          label: 'API',
          position: { x: 400, y: 0 },
          config: { instances: 2, vcpu: 2, cpuMsPerRequest: 8, operations: {} },
        },
        {
          id: 'db',
          serviceId: 'aws.rds_postgres',
          label: 'Postgres',
          position: { x: 600, y: 0 },
          config: { instances: 1, connections: { max: 100 }, operations: {} },
        },
      ],
      edges: [
        {
          id: 'e1',
          from: 'c',
          to: 'lb',
          protocol: 'https',
          port: 443,
          callType: 'sync',
          weight: 1,
        },
        {
          id: 'e2',
          from: 'lb',
          to: 'app',
          protocol: 'http',
          port: 8080,
          callType: 'sync',
          weight: 1,
        },
        {
          id: 'e3',
          from: 'app',
          to: 'db',
          protocol: 'sql',
          port: 5432,
          callType: 'sync',
          weight: 1,
        },
      ],
      groups: [],
      network: {},
      scenarios: [],
      scripts: [],
      fixtures: [],
      settings: { seed: 42, currency: 'USD', includeFreeTier: false },
    };

    const res = validateDesign(tinyDesign);
    expect(res.valid).toBe(true);
  });

  it('rejects malformed design documents with clear errors', () => {
    const invalid = {
      schemaVersion: 2,
      id: 'bad',
      name: 'Bad design',
      nodes: [],
      edges: [
        {
          id: 'e1',
          from: 'a',
          to: 'b',
          protocol: 'http',
          callType: 'invalid-call-type',
          weight: 1,
        },
      ],
      groups: [],
      network: {},
      scenarios: [],
      scripts: [],
      fixtures: [],
      settings: { seed: 42, currency: 'BTC', includeFreeTier: false },
    };

    const res = validateDesign(invalid);
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('creates an empty network config with all collections initialized', () => {
    const net = createEmptyNetworkConfig();
    expect(net.networks).toEqual([]);
    expect(net.subnets).toEqual([]);
    expect(net.firewalls).toEqual([]);
    expect(net.attachments).toEqual([]);
  });
});
