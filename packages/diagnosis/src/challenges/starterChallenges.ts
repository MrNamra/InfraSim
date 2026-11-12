import { createEmptyDesign, type Challenge, type Design } from '@infrasim/shared-types';

function makeBaseDesign(
  id: string,
  name: string,
  provider: 'aws' | 'gcp' | 'azure' | 'oci' = 'aws',
  region = 'us-east-1',
  seed = 42,
): Design {
  const design = createEmptyDesign(id, name);
  design.settings = {
    seed,
    primaryProvider: provider,
    currency: 'USD',
    includeFreeTier: true,
  };
  design.nodes = design.nodes.map((n) => ({ ...n, region }));
  return design;
}

function buildFirstBlood(): Challenge {
  const starter = makeBaseDesign('ch-first-blood', 'First Blood', 'aws', 'us-east-1', 101);
  starter.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Web Clients',
      region: 'us-east-1',
      position: { x: 80, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'API Server',
      region: 'us-east-1',
      az: 'us-east-1a',
      position: { x: 360, y: 180 },
      config: {
        instances: 1,
        instanceType: 't3.micro',
        vcpu: 1,
        cluster: false,
        maxInFlightPerInstance: 10,
        cpuMsPerRequest: 15,
        queue: { maxLength: 20, policy: 'reject' },
        latency: { distribution: 'fixed', p50: 25, p95: 40 },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e-c-a', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
  ];

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'scen-first-blood',
    name: '200 RPS Launch Traffic',
    durationS: 8,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 200 },
    flows: [{ id: 'f1', name: 'Browse', weight: 1, steps: [{ method: 'GET', path: '/items' }] }],
    chaos: [],
  };
  starter.scenarios = [fixedScenario];

  const solution: Design = structuredClone(starter);
  solution.nodes[1]!.az = 'multi-az';
  solution.nodes[1]!.config.instances = 4;
  solution.nodes[1]!.config.vcpu = 2;
  solution.nodes[1]!.config.cluster = true;
  solution.nodes[1]!.config.maxInFlightPerInstance = 40;

  return {
    slug: 'first-blood',
    title: 'First Blood',
    difficulty: 'beginner',
    story:
      'Your launch endpoint runs on a single t3.micro instance and collapses under 200 RPS. Scale it cleanly across availability zones while keeping monthly compute under $100.',
    learningGoals: [
      'Spot single-instance CPU and concurrency exhaustion',
      'Right-size instance count and worker concurrency for budget targets',
    ],
    starterDesign: starter,
    allowedServices: ['aws.*'],
    fixedScenario,
    fixedSeed: 101,
    pinnedPriceSnapshotId: 'pin-starter-v1',
    constraints: {
      maxMonthlyCostUsd: 100,
      p95MsMax: 300,
      errorRateMax: 0.02,
      requiredCapabilities: ['multi-az'],
    },
    scoring: {
      weights: { latency: 0.3, cost: 0.25, resilience: 0.25, security: 0.1, simplicity: 0.1 },
    },
    hints: [
      { afterAttempts: 1, text: 'Enable cluster workers and scale API instances to 4.' },
      { afterAttempts: 2, text: 'Set API availability zone to multi-az for fault tolerance.' },
    ],
    whatThisTeaches:
      'Horizontal scaling across multiple availability zones spreads CPU and concurrency load while removing single-AZ outage risk.',
    referenceSolutionDesign: solution,
    published: true,
  };
}

function buildReadHeavyShop(): Challenge {
  const starter = makeBaseDesign('ch-read-shop', 'Read-Heavy Shop', 'aws', 'us-east-1', 202);
  starter.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Shoppers',
      region: 'us-east-1',
      position: { x: 60, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'Catalog API',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 300, y: 180 },
      config: {
        instances: 4,
        instanceType: 'c6i.large',
        vcpu: 2,
        cluster: true,
        maxInFlightPerInstance: 120,
        cpuMsPerRequest: 1,
        latency: { distribution: 'fixed', p50: 4, p95: 8 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Catalog DB',
      region: 'us-east-1',
      az: 'us-east-1a',
      position: { x: 580, y: 180 },
      config: {
        instances: 1,
        instanceType: 'db.t3.micro',
        vcpu: 2,
        cluster: true,
        maxInFlightPerInstance: 16,
        cpuMsPerRequest: 8,
        readRatio: 0.9,
        connections: { max: 20 },
        queue: { maxLength: 10, policy: 'reject' },
        latency: { distribution: 'fixed', p50: 18, p95: 32 },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
    { id: 'e2', from: 'api', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 },
  ];

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'scen-read-shop',
    name: '1200 RPS Product Reads',
    durationS: 8,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 1200 },
    flows: [{ id: 'f1', name: 'ReadCatalog', weight: 1, steps: [{ method: 'GET', path: '/sku' }] }],
    chaos: [],
  };
  starter.scenarios = [fixedScenario];

  const solution: Design = structuredClone(starter);
  solution.nodes.splice(2, 0, {
    id: 'cache',
    serviceId: 'aws.elasticache_redis',
    label: 'Redis Cache',
    region: 'us-east-1',
    az: 'multi-az',
    position: { x: 450, y: 90 },
    config: {
      instances: 2,
      instanceType: 'cache.t3.micro',
      vcpu: 2,
      cluster: true,
      maxInFlightPerInstance: 300,
      cpuMsPerRequest: 0.2,
      cacheHitRatio: 0.92,
      latency: { distribution: 'fixed', p50: 1, p95: 2 },
      operations: {},
    },
  });
  solution.edges = [
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
    { id: 'e2', from: 'api', to: 'cache', protocol: 'redis', callType: 'sync', weight: 1 },
    { id: 'e3', from: 'cache', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 },
  ];

  return {
    slug: 'read-heavy-shop',
    title: 'Read-Heavy Shop',
    difficulty: 'beginner',
    story:
      'Ninety percent of storefront traffic fetches immutable product pages, hammering PostgreSQL until its connection pool overflows. Introduce a read-through cache without breaking the budget.',
    learningGoals: [
      'Understand read-through cache hit ratios vs origin load',
      'Relieve database connection pool saturation cleanly',
    ],
    starterDesign: starter,
    allowedServices: ['aws.*'],
    fixedScenario,
    fixedSeed: 202,
    pinnedPriceSnapshotId: 'pin-starter-v1',
    constraints: {
      maxMonthlyCostUsd: 350,
      p95MsMax: 250,
      errorRateMax: 0.02,
      requiredCapabilities: ['cache'],
    },
    scoring: {
      weights: { latency: 0.3, cost: 0.25, resilience: 0.2, security: 0.1, simplicity: 0.15 },
    },
    hints: [
      { afterAttempts: 1, text: 'Insert an ElastiCache Redis node between API and Catalog DB.' },
      {
        afterAttempts: 2,
        text: 'Configure a 90%+ cache hit ratio so only misses reach PostgreSQL.',
      },
    ],
    whatThisTeaches:
      'A high-hit-ratio read-through cache cuts downstream DB QPS and connection demand by an order of magnitude at lower latency than vertical DB upgrades.',
    referenceSolutionDesign: solution,
    published: true,
  };
}

function buildMidnightSpike(): Challenge {
  const starter = makeBaseDesign(
    'ch-midnight-spike',
    'The Midnight Spike',
    'aws',
    'us-east-1',
    303,
  );
  starter.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Ticket Buyers',
      region: 'us-east-1',
      position: { x: 80, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ecs_ec2',
      label: 'Drop Service',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 380, y: 180 },
      config: {
        instances: 1,
        instanceType: 'c6i.large',
        vcpu: 2,
        cluster: true,
        maxInFlightPerInstance: 30,
        cpuMsPerRequest: 10,
        queue: { maxLength: 30, policy: 'reject' },
        latency: { distribution: 'fixed', p50: 15, p95: 25 },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
  ];

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'scen-midnight-spike',
    name: '10x Flash Sale Spike',
    durationS: 30,
    entryNodeId: 'client',
    profile: { kind: 'spike', baseRps: 60, peakRps: 600, atS: 8, widthS: 12 },
    flows: [{ id: 'f1', name: 'Claim', weight: 1, steps: [{ method: 'POST', path: '/claim' }] }],
    chaos: [],
  };
  starter.scenarios = [fixedScenario];

  const solution: Design = structuredClone(starter);
  solution.nodes[1]!.config.instances = 4;
  solution.nodes[1]!.config.maxInFlightPerInstance = 80;
  solution.nodes[1]!.config.autoscaling = {
    min: 3,
    max: 14,
    metric: 'inflight',
    target: 0.45,
    scaleOutCooldownS: 2,
    scaleInCooldownS: 20,
    warmupS: 1,
    checkIntervalS: 1,
  };

  return {
    slug: 'midnight-spike',
    title: 'The Midnight Spike',
    difficulty: 'intermediate',
    story:
      'Every night at 00:00 traffic jumps 10x for twelve seconds during a limited drop. Configure fast autoscaling and headroom so error rate stays under 1% without overpaying at baseline.',
    learningGoals: [
      'Match autoscaling warmup and target utilization to sudden spikes',
      'Balance baseline capacity headroom with elastic scale-out',
    ],
    starterDesign: starter,
    allowedServices: ['aws.*'],
    fixedScenario,
    fixedSeed: 303,
    pinnedPriceSnapshotId: 'pin-starter-v1',
    constraints: {
      p95MsMax: 350,
      errorRateMax: 0.01,
      requiredCapabilities: ['autoscaling'],
    },
    scoring: {
      weights: { latency: 0.3, cost: 0.25, resilience: 0.25, security: 0.05, simplicity: 0.15 },
    },
    hints: [
      {
        afterAttempts: 1,
        text: 'Enable autoscaling on Drop Service with a low utilization target (e.g. 0.45).',
      },
      {
        afterAttempts: 2,
        text: 'Keep minimum instances >= 3 and short warmup so burst traffic does not queue-reject before scale-out completes.',
      },
    ],
    whatThisTeaches:
      'Reactive autoscaling only works when baseline headroom absorbs traffic during container warmup.',
    referenceSolutionDesign: solution,
    published: true,
  };
}

function buildZoneDown(): Challenge {
  const starter = makeBaseDesign('ch-zone-down', 'Zone Down', 'aws', 'us-east-1', 404);
  starter.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Users',
      region: 'us-east-1',
      position: { x: 60, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'lb',
      serviceId: 'aws.alb',
      label: 'Public ALB',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 260, y: 180 },
      config: {
        instances: 2,
        cluster: true,
        maxInFlightPerInstance: 500,
        latency: { distribution: 'fixed', p50: 2, p95: 4 },
        operations: {},
      },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'Orders API',
      region: 'us-east-1',
      az: 'us-east-1a',
      position: { x: 480, y: 180 },
      config: {
        instances: 1,
        instanceType: 't3.small',
        vcpu: 2,
        cluster: true,
        maxInFlightPerInstance: 60,
        cpuMsPerRequest: 3,
        latency: { distribution: 'fixed', p50: 10, p95: 18 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Orders DB',
      region: 'us-east-1',
      az: 'us-east-1a',
      position: { x: 700, y: 180 },
      config: {
        instances: 1,
        instanceType: 'db.t3.micro',
        vcpu: 2,
        cluster: true,
        maxInFlightPerInstance: 100,
        cpuMsPerRequest: 1,
        connections: { max: 120 },
        latency: { distribution: 'fixed', p50: 6, p95: 12 },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e1', from: 'client', to: 'lb', protocol: 'https', callType: 'sync', weight: 1 },
    { id: 'e2', from: 'lb', to: 'api', protocol: 'http', callType: 'sync', weight: 1 },
    { id: 'e3', from: 'api', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 },
  ];

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'scen-zone-down',
    name: 'AZ Blackout Chaos',
    durationS: 12,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 120 },
    flows: [
      { id: 'f1', name: 'OrderCheck', weight: 1, steps: [{ method: 'GET', path: '/orders' }] },
    ],
    chaos: [{ atS: 2, durationS: 8, kind: 'az-outage', az: 'us-east-1a' }],
  };
  starter.scenarios = [fixedScenario];

  const solution: Design = structuredClone(starter);
  solution.nodes[2]!.az = 'multi-az';
  solution.nodes[2]!.config.instances = 4;
  solution.nodes[3]!.az = 'multi-az';
  solution.nodes[3]!.config.instances = 2;

  return {
    slug: 'zone-down',
    title: 'Zone Down',
    difficulty: 'intermediate',
    story:
      'Availability Zone us-east-1a drops offline mid-run. Right now every API node and database sits inside us-east-1a, causing total downtime. Achieve >= 99% availability through the outage.',
    learningGoals: [
      'Eliminate zonal single points of failure across compute and data layers',
      'Verify failover availability under simulated AZ blackout chaos',
    ],
    starterDesign: starter,
    allowedServices: ['aws.*'],
    fixedScenario,
    fixedSeed: 404,
    pinnedPriceSnapshotId: 'pin-starter-v1',
    constraints: {
      minAvailabilityUnderChaos: 0.99,
      p95MsMax: 300,
      requiredCapabilities: ['multi-az'],
    },
    scoring: {
      weights: { latency: 0.25, cost: 0.2, resilience: 0.4, security: 0.05, simplicity: 0.1 },
    },
    hints: [
      { afterAttempts: 1, text: 'Move both Orders API and Orders DB to multi-az deployment.' },
      {
        afterAttempts: 2,
        text: 'Size Orders API >= 4 instances so surviving AZ capacity handles full load.',
      },
    ],
    whatThisTeaches:
      'True multi-AZ resilience requires redundancy at every tier on the critical request path plus headroom for half-capacity survival.',
    referenceSolutionDesign: solution,
    published: true,
  };
}

function buildRetryStorm(): Challenge {
  const starter = makeBaseDesign('ch-retry-storm', 'Retry Storm', 'aws', 'us-east-1', 505);
  starter.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Mobile App',
      region: 'us-east-1',
      position: { x: 80, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'Profile API',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 340, y: 180 },
      config: {
        instances: 3,
        instanceType: 'c6i.large',
        vcpu: 2,
        cluster: true,
        maxInFlightPerInstance: 60,
        cpuMsPerRequest: 2,
        latency: { distribution: 'fixed', p50: 5, p95: 10 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Profile DB',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 620, y: 180 },
      config: {
        instances: 2,
        instanceType: 'db.t3.micro',
        vcpu: 2,
        cluster: true,
        maxInFlightPerInstance: 18,
        cpuMsPerRequest: 4,
        connections: { max: 20 },
        queue: { maxLength: 10, policy: 'reject' },
        latency: { distribution: 'fixed', p50: 15, p95: 25 },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
    {
      id: 'e2',
      from: 'api',
      to: 'db',
      protocol: 'sql',
      callType: 'sync',
      weight: 1,
      retry: { max: 6, backoffMs: 0, jitter: false },
    },
  ];

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'scen-retry-storm',
    name: 'Transient DB Blip + Retries',
    durationS: 14,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 250 },
    flows: [{ id: 'f1', name: 'LoadProfile', weight: 1, steps: [{ method: 'GET', path: '/me' }] }],
    chaos: [{ atS: 2, durationS: 4, kind: 'add-latency', nodeId: 'db', extraMs: 250 }],
  };
  starter.scenarios = [fixedScenario];

  const solution: Design = structuredClone(starter);
  solution.nodes[1]!.config.timeoutMs = 500;
  solution.nodes[2]!.config.maxInFlightPerInstance = 150;
  solution.nodes[2]!.config.connections = { max: 250 };
  solution.nodes.splice(2, 0, {
    id: 'cache',
    serviceId: 'aws.elasticache_redis',
    label: 'Profile Cache',
    region: 'us-east-1',
    az: 'multi-az',
    position: { x: 480, y: 80 },
    config: {
      instances: 2,
      instanceType: 'cache.t3.micro',
      vcpu: 2,
      cluster: true,
      maxInFlightPerInstance: 300,
      cpuMsPerRequest: 0.2,
      cacheHitRatio: 0.85,
      latency: { distribution: 'fixed', p50: 1, p95: 2 },
      operations: {},
    },
  });
  solution.edges = [
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
    {
      id: 'e2',
      from: 'api',
      to: 'cache',
      protocol: 'redis',
      callType: 'sync',
      weight: 1,
      retry: { max: 1, backoffMs: 15, jitter: true },
    },
    {
      id: 'e3',
      from: 'cache',
      to: 'db',
      protocol: 'sql',
      callType: 'sync',
      weight: 1,
      retry: { max: 1, backoffMs: 25, jitter: true },
      circuitBreaker: {
        failureThreshold: 0.4,
        windowMs: 4000,
        openMs: 3000,
      },
    },
  ];

  return {
    slug: 'retry-storm',
    title: 'Retry Storm',
    difficulty: 'intermediate',
    story:
      'Aggressive immediate retries (6 attempts with 0 ms backoff) amplify a short database slowdown into a full connection pool meltdown. Calm retries with jitter/circuit breaking and offload reads.',
    learningGoals: [
      'Recognize retry amplification loops in distributed traces',
      'Apply bounded retries, jitter, and circuit breakers cleanly',
    ],
    starterDesign: starter,
    allowedServices: ['aws.*'],
    fixedScenario,
    fixedSeed: 505,
    pinnedPriceSnapshotId: 'pin-starter-v1',
    constraints: {
      p95MsMax: 320,
      errorRateMax: 0.05,
      requiredCapabilities: ['cache'],
    },
    scoring: {
      weights: { latency: 0.3, cost: 0.2, resilience: 0.35, security: 0.05, simplicity: 0.1 },
    },
    hints: [
      {
        afterAttempts: 1,
        text: 'Reduce retries on the DB edge to 1–2 with jittered backoff and add a circuit breaker.',
      },
      {
        afterAttempts: 2,
        text: 'Place Redis in front of the DB and increase DB connection headroom.',
      },
    ],
    whatThisTeaches:
      'Zero-backoff retries multiply offered load by N during brownouts; backoff with jitter plus circuit breakers prevents self-inflicted outages.',
    referenceSolutionDesign: solution,
    published: true,
  };
}

function buildFireAndForget(): Challenge {
  const starter = makeBaseDesign('ch-fire-forget', 'Fire and Forget', 'aws', 'us-east-1', 606);
  starter.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Buyers',
      region: 'us-east-1',
      position: { x: 60, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'checkout',
      serviceId: 'aws.ecs_ec2',
      label: 'Checkout API',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 300, y: 180 },
      config: {
        instances: 3,
        instanceType: 'c6i.large',
        vcpu: 2,
        cluster: true,
        maxInFlightPerInstance: 30,
        cpuMsPerRequest: 2,
        queue: { maxLength: 20, policy: 'reject' },
        latency: { distribution: 'fixed', p50: 8, p95: 15 },
        operations: {},
      },
    },
    {
      id: 'fulfill',
      serviceId: 'aws.lambda',
      label: 'PDF & Email Job',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 580, y: 180 },
      config: {
        instances: 1,
        vcpu: 1,
        maxInFlightPerInstance: 15,
        cpuMsPerRequest: 20,
        latency: { distribution: 'fixed', p50: 950, p95: 1300 },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e1', from: 'client', to: 'checkout', protocol: 'https', callType: 'sync', weight: 1 },
    { id: 'e2', from: 'checkout', to: 'fulfill', protocol: 'http', callType: 'sync', weight: 1 },
  ];

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'scen-fire-forget',
    name: 'Checkout Under Slow Receipt Job',
    durationS: 10,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 180 },
    flows: [
      { id: 'f1', name: 'SubmitOrder', weight: 1, steps: [{ method: 'POST', path: '/checkout' }] },
    ],
    chaos: [],
  };
  starter.scenarios = [fixedScenario];

  const solution: Design = structuredClone(starter);
  solution.nodes[1]!.config.maxInFlightPerInstance = 100;
  solution.nodes.splice(2, 0, {
    id: 'q1',
    serviceId: 'aws.sqs',
    label: 'Receipt Queue',
    region: 'us-east-1',
    az: 'multi-az',
    position: { x: 460, y: 180 },
    config: {
      instances: 1,
      maxInFlightPerInstance: 1000,
      latency: { distribution: 'fixed', p50: 3, p95: 6 },
      operations: {},
    },
  });
  solution.nodes[3]!.position = { x: 700, y: 180 };
  solution.nodes[3]!.config.consumer = {
    concurrency: 80,
    batchSize: 10,
    pollMs: 50,
    maxRetries: 3,
    dlq: true,
  };
  solution.edges = [
    { id: 'e1', from: 'client', to: 'checkout', protocol: 'https', callType: 'sync', weight: 1 },
    { id: 'e2', from: 'checkout', to: 'q1', protocol: 'https', callType: 'async', weight: 1 },
    { id: 'e3', from: 'q1', to: 'fulfill', protocol: 'internal', callType: 'async', weight: 1 },
  ];

  return {
    slug: 'fire-and-forget',
    title: 'Fire and Forget',
    difficulty: 'intermediate',
    story:
      'Checkout synchronously waits 1 second for PDF receipt rendering, pinning API worker slots until buyers see 503 drops. Decouple receipt work onto an async queue backed by a Dead-Letter Queue.',
    learningGoals: [
      'Separate fast user-facing acknowledgement from slow background work',
      'Configure SQS async edges and worker DLQ handling',
    ],
    starterDesign: starter,
    allowedServices: ['aws.*'],
    fixedScenario,
    fixedSeed: 606,
    pinnedPriceSnapshotId: 'pin-starter-v1',
    constraints: {
      p95MsMax: 250,
      errorRateMax: 0.02,
      requiredCapabilities: ['async-queue', 'dlq'],
    },
    scoring: {
      weights: { latency: 0.35, cost: 0.2, resilience: 0.3, security: 0.05, simplicity: 0.1 },
    },
    hints: [
      {
        afterAttempts: 1,
        text: 'Insert an aws.sqs node between Checkout API and the PDF worker with callType set to async.',
      },
      { afterAttempts: 2, text: 'Enable DLQ (consumer.dlq = true) on the background worker.' },
    ],
    whatThisTeaches:
      'Asynchronous queues shield synchronous request paths from downstream latency tails while DLQs guarantee failed jobs are never silently lost.',
    referenceSolutionDesign: solution,
    published: true,
  };
}

function makeLockedDownNetwork(secure: boolean): Design['network'] {
  return {
    networks: [
      {
        id: 'vpc1',
        provider: 'aws',
        region: 'us-east-1',
        cidrs: ['10.0.0.0/16'],
        name: 'main-vpc',
      },
    ],
    subnets: [
      {
        id: 'pub-a',
        networkId: 'vpc1',
        cidr: '10.0.1.0/24',
        az: 'us-east-1a',
        routeTableId: 'rt-pub',
        autoAssignPublicIp: true,
      },
      {
        id: 'priv-app',
        networkId: 'vpc1',
        cidr: '10.0.10.0/24',
        az: 'us-east-1a',
        routeTableId: 'rt-priv',
        autoAssignPublicIp: false,
      },
      {
        id: 'priv-db',
        networkId: 'vpc1',
        cidr: '10.0.20.0/24',
        az: 'us-east-1a',
        routeTableId: secure ? 'rt-priv' : 'rt-pub',
        autoAssignPublicIp: !secure,
      },
    ],
    routeTables: [
      {
        id: 'rt-pub',
        routes: [
          { dest: '10.0.0.0/16', target: { kind: 'local' } },
          { dest: '0.0.0.0/0', target: { kind: 'igw' } },
        ],
      },
      {
        id: 'rt-priv',
        routes: [{ dest: '10.0.0.0/16', target: { kind: 'local' } }],
      },
    ],
    gateways: [{ id: 'igw1', kind: 'igw', networkId: 'vpc1', publicIp: true }],
    firewalls: [
      {
        id: 'sg-alb',
        kind: 'sg',
        stateful: true,
        rules: [
          {
            id: 'r-alb-in',
            direction: 'ingress',
            action: 'allow',
            protocol: 'tcp',
            portFrom: 443,
            portTo: 443,
            source: { cidr: '0.0.0.0/0' },
          },
          {
            id: 'r-alb-out',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { cidr: '0.0.0.0/0' },
          },
        ],
        attachedTo: { nodeIds: ['alb'] },
      },
      {
        id: 'sg-app',
        kind: 'sg',
        stateful: true,
        rules: [
          {
            id: 'r-app-in',
            direction: 'ingress',
            action: 'allow',
            protocol: 'tcp',
            portFrom: 8080,
            portTo: 8080,
            source: { cidr: '10.0.1.0/24' },
          },
          {
            id: 'r-app-out',
            direction: 'egress',
            action: 'allow',
            protocol: 'any',
            destination: { cidr: '0.0.0.0/0' },
          },
        ],
        attachedTo: { nodeIds: ['app'] },
      },
      {
        id: 'sg-db',
        kind: 'sg',
        stateful: true,
        rules: secure
          ? [
              {
                id: 'r-db-in-safe',
                direction: 'ingress',
                action: 'allow',
                protocol: 'tcp',
                portFrom: 5432,
                portTo: 5432,
                source: { cidr: '10.0.10.0/24' },
              },
            ]
          : [
              {
                id: 'r-db-in-bad',
                direction: 'ingress',
                action: 'allow',
                protocol: 'tcp',
                portFrom: 5432,
                portTo: 5432,
                source: { cidr: '0.0.0.0/0' },
              },
            ],
        attachedTo: { nodeIds: ['db'] },
      },
    ],
    attachments: [
      {
        nodeId: 'alb',
        subnetId: 'pub-a',
        firewallIds: ['sg-alb'],
        privateIp: '10.0.1.10',
        publicIp: '54.1.2.10',
      },
      { nodeId: 'app', subnetId: 'priv-app', firewallIds: ['sg-app'], privateIp: '10.0.10.10' },
      {
        nodeId: 'db',
        subnetId: 'priv-db',
        firewallIds: ['sg-db'],
        privateIp: '10.0.20.10',
        ...(secure ? {} : { publicIp: '54.1.2.20' }),
      },
    ],
  };
}

function buildLockedDown(): Challenge {
  const starter = makeBaseDesign('ch-locked-down', 'Locked Down', 'aws', 'us-east-1', 707);
  starter.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Client',
      region: 'us-east-1',
      position: { x: 60, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'alb',
      serviceId: 'aws.alb',
      label: 'ALB',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 260, y: 180 },
      config: { instances: 2, maxInFlightPerInstance: 500, errorRate: 0.001, operations: {} },
    },
    {
      id: 'app',
      serviceId: 'aws.ec2',
      label: 'Private App',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 480, y: 180 },
      config: {
        instances: 2,
        instanceType: 't3.small',
        vcpu: 2,
        cluster: true,
        errorRate: 0.001,
        maxInFlightPerInstance: 60,
        cpuMsPerRequest: 2,
        latency: { distribution: 'fixed', p50: 8, p95: 14 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'aws.rds_postgres',
      label: 'Private DB',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 700, y: 180 },
      config: {
        instances: 2,
        instanceType: 'db.t3.micro',
        vcpu: 2,
        cluster: true,
        errorRate: 0.001,
        maxInFlightPerInstance: 80,
        cpuMsPerRequest: 1,
        connections: { max: 100 },
        latency: { distribution: 'fixed', p50: 5, p95: 10 },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e1', from: 'client', to: 'alb', protocol: 'https', callType: 'sync', weight: 1 },
    { id: 'e2', from: 'alb', to: 'app', protocol: 'http', callType: 'sync', weight: 1 },
    { id: 'e3', from: 'app', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 },
  ];
  starter.network = makeLockedDownNetwork(false);

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'scen-locked-down',
    name: 'Secure 3-Tier Check',
    durationS: 20,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 100 },
    flows: [{ id: 'f1', name: 'Query', weight: 1, steps: [{ method: 'GET', path: '/health' }] }],
    chaos: [],
  };
  starter.scenarios = [fixedScenario];

  const solution: Design = structuredClone(starter);
  solution.network = makeLockedDownNetwork(true);

  return {
    slug: 'locked-down',
    title: 'Locked Down',
    difficulty: 'intermediate',
    story:
      'PostgreSQL sits on a public route table with 0.0.0.0/0 port 5432 ingress wide open. Place the database in a private subnet and restrict ingress strictly to the app subnet.',
    learningGoals: [
      'Isolate databases inside private VPC subnets without IGW routes',
      'Write least-privilege security group rules between tiers',
    ],
    starterDesign: starter,
    allowedServices: ['aws.*'],
    fixedScenario,
    fixedSeed: 707,
    pinnedPriceSnapshotId: 'pin-starter-v1',
    constraints: {
      p95MsMax: 300,
      errorRateMax: 0.01,
      requiredCapabilities: ['private-db'],
      forbidden: ['public-db', 'wide-open-ingress'],
      mustBeReachable: [
        { from: 'client', to: 'alb', port: 443 },
        { from: 'alb', to: 'app', port: 8080 },
        { from: 'app', to: 'db', port: 5432 },
      ],
    },
    scoring: {
      weights: { latency: 0.2, cost: 0.15, resilience: 0.2, security: 0.35, simplicity: 0.1 },
    },
    hints: [
      {
        afterAttempts: 1,
        text: 'Move priv-db onto rt-priv and remove publicIp from the DB attachment.',
      },
      {
        afterAttempts: 2,
        text: 'Replace 0.0.0.0/0 in sg-db with source CIDR 10.0.10.0/24 on TCP port 5432.',
      },
    ],
    whatThisTeaches:
      'Least-privilege networking pairs private route tables (no internet gateway) with tier-scoped security groups so only authorized upstream subnets can reach port 5432.',
    referenceSolutionDesign: solution,
    published: true,
  };
}

function buildBudgetCloud(): Challenge {
  const starter = makeBaseDesign('ch-budget-cloud', 'Budget Cloud', 'aws', 'us-east-1', 808);
  starter.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Global Edge',
      region: 'us-east-1',
      position: { x: 60, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'Compute Fleet',
      region: 'us-east-1',
      az: 'us-east-1a',
      position: { x: 380, y: 180 },
      config: {
        instances: 1,
        instanceType: 'm5.large',
        vcpu: 2,
        cluster: false,
        maxInFlightPerInstance: 30,
        cpuMsPerRequest: 1.5,
        queue: { maxLength: 20, policy: 'reject' },
        latency: { distribution: 'fixed', p50: 4, p95: 9 },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
  ];

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'scen-budget-cloud',
    name: '5k RPS Efficiency Test',
    durationS: 5,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 5000 },
    flows: [{ id: 'f1', name: 'FastAPI', weight: 1, steps: [{ method: 'GET', path: '/v1/ping' }] }],
    chaos: [],
  };
  starter.scenarios = [fixedScenario];

  const solution: Design = structuredClone(starter);
  solution.nodes[1]!.az = 'multi-az';
  solution.nodes[1]!.config = {
    instances: 4,
    instanceType: 'c6i.large',
    vcpu: 2,
    cluster: true,
    runtimePreset: 'go',
    maxInFlightPerInstance: 400,
    cpuMsPerRequest: 0.25,
    queue: { maxLength: 500, policy: 'reject' },
    latency: { distribution: 'fixed', p50: 3, p95: 7 },
    operations: {},
  };

  return {
    slug: 'budget-cloud',
    title: 'Budget Cloud',
    difficulty: 'advanced',
    story:
      'Handle 5,000 RPS with p99 under 250 ms and error rate below 1% for less than $500/month using any cloud provider.',
    learningGoals: [
      'Tune runtime concurrency and CPU efficiency per instance',
      'Optimize price/performance under strict throughput and tail-latency SLAs',
    ],
    starterDesign: starter,
    fixedScenario,
    fixedSeed: 808,
    pinnedPriceSnapshotId: 'pin-starter-v1',
    constraints: {
      maxMonthlyCostUsd: 500,
      p99MsMax: 250,
      errorRateMax: 0.01,
      requiredCapabilities: ['multi-az'],
    },
    scoring: {
      weights: { latency: 0.3, cost: 0.35, resilience: 0.2, security: 0.05, simplicity: 0.1 },
    },
    hints: [
      {
        afterAttempts: 1,
        text: 'Switch runtime preset to Go (or cluster mode) so instances handle high concurrency.',
      },
      {
        afterAttempts: 2,
        text: 'Scale to 4 c6i.large instances across multiple AZs (~$248/mo) and keep cpuMsPerRequest <= 0.3 ms.',
      },
    ],
    whatThisTeaches:
      'Efficiency gains in runtime concurrency and per-request CPU shave whole server tiers off monthly cloud bills.',
    referenceSolutionDesign: solution,
    published: true,
  };
}

function buildLlmAtScale(): Challenge {
  const starter = makeBaseDesign('ch-llm-scale', 'LLM at Scale', 'aws', 'us-east-1', 909);
  starter.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Chat Users',
      region: 'us-east-1',
      position: { x: 60, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ecs_ec2',
      label: 'Chat Gateway',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 280, y: 180 },
      config: {
        instances: 2,
        instanceType: 'c6i.large',
        vcpu: 2,
        cluster: true,
        maxInFlightPerInstance: 80,
        cpuMsPerRequest: 2,
        latency: { distribution: 'fixed', p50: 4, p95: 8 },
        operations: {},
      },
    },
    {
      id: 'llm',
      serviceId: 'aws.bedrock',
      label: 'Bedrock Foundation Model',
      region: 'us-east-1',
      az: 'multi-az',
      position: { x: 600, y: 180 },
      config: {
        instances: 1,
        maxInFlightPerInstance: 30,
        timeoutMs: 3000,
        latency: { distribution: 'fixed', p50: 120, p95: 190 },
        rateLimit: { tpm: 30_000, rpm: 300, maxContextTokens: 8192 },
        ai: {
          modelLabel: 'Claude 3.5 Sonnet',
          profile: 'balanced',
          capacityMode: 'on-demand',
          outputTokens: { distribution: 'fixed', p50: 300, p95: 450 },
        },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
    {
      id: 'e2',
      from: 'api',
      to: 'llm',
      protocol: 'https',
      callType: 'sync',
      weight: 1,
    },
  ];

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'scen-llm-scale',
    name: '50 RPS Chat Load',
    durationS: 8,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 50 },
    flows: [
      { id: 'f1', name: 'ChatCompletion', weight: 1, steps: [{ method: 'POST', path: '/chat' }] },
    ],
    chaos: [],
  };
  starter.scenarios = [fixedScenario];

  const solution: Design = structuredClone(starter);
  solution.nodes.splice(2, 0, {
    id: 'cache',
    serviceId: 'aws.elasticache_redis',
    label: 'Prompt Cache',
    region: 'us-east-1',
    az: 'multi-az',
    position: { x: 440, y: 80 },
    config: {
      instances: 2,
      instanceType: 'cache.t3.micro',
      vcpu: 2,
      cluster: true,
      maxInFlightPerInstance: 200,
      cpuMsPerRequest: 0.2,
      cacheHitRatio: 0.78,
      latency: { distribution: 'fixed', p50: 1, p95: 2 },
      operations: {},
    },
  });
  solution.nodes[3]!.config.rateLimit = { tpm: 2_000_000, rpm: 3000, maxContextTokens: 8192 };
  solution.nodes[3]!.config.maxInFlightPerInstance = 100;
  solution.nodes[3]!.config.ai = {
    modelLabel: 'Claude 3.5 Sonnet (Provisioned)',
    profile: 'small-fast',
    capacityMode: 'provisioned',
    provisionedUnits: 2,
    outputTokens: { distribution: 'fixed', p50: 120, p95: 180 },
  };
  solution.edges = [
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
    { id: 'e2', from: 'api', to: 'cache', protocol: 'redis', callType: 'sync', weight: 1 },
    {
      id: 'e3',
      from: 'cache',
      to: 'llm',
      protocol: 'https',
      callType: 'sync',
      weight: 1,
      retry: { max: 1, backoffMs: 50, jitter: true },
    },
  ];

  return {
    slug: 'llm-at-scale',
    title: 'LLM at Scale',
    difficulty: 'advanced',
    story:
      'Your 50 RPS AI assistant hits Bedrock token-per-minute (TPM) throttling right away. Add semantic prompt caching, trim prompt footprint, and move to provisioned throughput so errors drop below 1%.',
    learningGoals: [
      'Protect scarce foundation-model TPM quotas with prompt caching',
      'Right-size token budgets and provisioned model capacity',
    ],
    starterDesign: starter,
    allowedServices: ['aws.*'],
    fixedScenario,
    fixedSeed: 909,
    pinnedPriceSnapshotId: 'pin-starter-v1',
    constraints: {
      errorRateMax: 0.01,
      p95MsMax: 400,
      requiredCapabilities: ['cache'],
    },
    scoring: {
      weights: { latency: 0.3, cost: 0.2, resilience: 0.3, security: 0.05, simplicity: 0.15 },
    },
    hints: [
      {
        afterAttempts: 1,
        text: 'Insert an ElastiCache Redis cache ahead of Bedrock with >= 75% hit ratio.',
      },
      {
        afterAttempts: 2,
        text: 'Switch Bedrock to provisioned throughput or raise TPM/RPM limits and trim prompt tokens.',
      },
    ],
    whatThisTeaches:
      'Prompt caching shrinks both token costs and TPM quota pressure on repeated queries while keeping tail latency low.',
    referenceSolutionDesign: solution,
    published: true,
  };
}

function buildCrossCloud(): Challenge {
  const starter = makeBaseDesign(
    'ch-cross-cloud',
    'Cross-Cloud Migration',
    'aws',
    'us-east-1',
    1010,
  );
  starter.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Users',
      region: 'us-east4',
      position: { x: 60, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'aws.ec2',
      label: 'Legacy AWS API',
      region: 'us-east-1',
      az: 'us-east-1a',
      position: { x: 340, y: 180 },
      config: {
        instances: 1,
        instanceType: 't3.micro',
        vcpu: 2,
        cluster: false,
        maxInFlightPerInstance: 20,
        cpuMsPerRequest: 8,
        queue: { maxLength: 10, policy: 'reject' },
        latency: { distribution: 'fixed', p50: 15, p95: 25 },
        operations: {},
      },
    },
  ];
  starter.edges = [
    { id: 'e1', from: 'client', to: 'api', protocol: 'https', callType: 'sync', weight: 1 },
  ];

  const fixedScenario: Challenge['fixedScenario'] = {
    id: 'scen-cross-cloud',
    name: 'GCP Target 400 RPS',
    durationS: 8,
    entryNodeId: 'client',
    profile: { kind: 'constant', rps: 400 },
    flows: [{ id: 'f1', name: 'ReadData', weight: 1, steps: [{ method: 'GET', path: '/data' }] }],
    chaos: [],
  };
  starter.scenarios = [fixedScenario];

  const solution = makeBaseDesign(
    'ch-cross-cloud',
    'Cross-Cloud Migration',
    'gcp',
    'us-east4',
    1010,
  );
  solution.nodes = [
    {
      id: 'client',
      serviceId: 'generic.client',
      label: 'Users',
      region: 'us-east4',
      position: { x: 60, y: 180 },
      config: { instances: 1, operations: {} },
    },
    {
      id: 'lb',
      serviceId: 'gcp.lb_https',
      label: 'Cloud Load Balancer',
      region: 'us-east4',
      az: 'multi-az',
      position: { x: 260, y: 180 },
      config: { instances: 2, maxInFlightPerInstance: 1000, operations: {} },
    },
    {
      id: 'api',
      serviceId: 'gcp.compute_engine',
      label: 'Compute Engine Pool',
      region: 'us-east4',
      az: 'multi-az',
      position: { x: 480, y: 180 },
      config: {
        instances: 2,
        instanceType: 'e2-small',
        vcpu: 1,
        memoryGb: 2,
        cluster: true,
        maxInFlightPerInstance: 160,
        cpuMsPerRequest: 1,
        latency: { distribution: 'fixed', p50: 6, p95: 12 },
        operations: {},
      },
    },
    {
      id: 'db',
      serviceId: 'gcp.cloud_sql_postgres',
      label: 'Cloud SQL Postgres',
      region: 'us-east4',
      az: 'multi-az',
      position: { x: 700, y: 180 },
      config: {
        instances: 2,
        vcpu: 1,
        memoryGb: 2,
        cluster: true,
        maxInFlightPerInstance: 180,
        cpuMsPerRequest: 1,
        connections: { max: 200 },
        latency: { distribution: 'fixed', p50: 5, p95: 10 },
        operations: {},
      },
    },
  ];
  solution.edges = [
    { id: 'e1', from: 'client', to: 'lb', protocol: 'https', callType: 'sync', weight: 1 },
    { id: 'e2', from: 'lb', to: 'api', protocol: 'http', callType: 'sync', weight: 1 },
    { id: 'e3', from: 'api', to: 'db', protocol: 'sql', callType: 'sync', weight: 1 },
  ];
  solution.scenarios = [fixedScenario];

  return {
    slug: 'cross-cloud',
    title: 'Cross-Cloud',
    difficulty: 'advanced',
    story:
      'Migrate a legacy AWS single-instance workload onto Google Cloud Platform (GCP) while serving 400 RPS under $500/month across multiple availability zones.',
    learningGoals: [
      'Translate AWS compute, LB, and database primitives to equivalent GCP services',
      'Compare multi-cloud cost vs latency behavior under pinned pricing',
    ],
    starterDesign: starter,
    fixedScenario,
    fixedSeed: 1010,
    pinnedPriceSnapshotId: 'pin-starter-v1',
    constraints: {
      maxMonthlyCostUsd: 500,
      p95MsMax: 300,
      errorRateMax: 0.01,
      requiredCapabilities: ['multi-az'],
      requiredProviders: ['gcp'],
    },
    scoring: {
      weights: { latency: 0.25, cost: 0.3, resilience: 0.25, security: 0.1, simplicity: 0.1 },
    },
    hints: [
      {
        afterAttempts: 1,
        text: 'Replace AWS EC2 with gcp.lb_https + gcp.compute_engine + gcp.cloud_sql_postgres in region us-east4.',
      },
      {
        afterAttempts: 2,
        text: 'Scale Compute Engine to 3 e2-medium multi-az instances in cluster mode.',
      },
    ],
    whatThisTeaches:
      'Equivalent managed services across AWS, GCP, Azure, and OCI map to the same queueing and redundancy fundamentals, with distinct SKU cost curves.',
    referenceSolutionDesign: solution,
    published: true,
  };
}

/**
 * The 10 canonical Spec 17 §6.3 starter challenges, spanning beginner, intermediate,
 * and advanced capacity, caching, chaos, resilience, async queues, VPC security,
 * LLM quotas, and cross-cloud design problems.
 */
export const STARTER_CHALLENGES: readonly Challenge[] = [
  buildFirstBlood(),
  buildReadHeavyShop(),
  buildMidnightSpike(),
  buildZoneDown(),
  buildRetryStorm(),
  buildFireAndForget(),
  buildLockedDown(),
  buildBudgetCloud(),
  buildLlmAtScale(),
  buildCrossCloud(),
];

export function getStarterChallenge(slug: string): Challenge | undefined {
  return STARTER_CHALLENGES.find((c) => c.slug === slug);
}
