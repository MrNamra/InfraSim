import type {
  LatencyModel,
  NodeConfig,
  RuntimePreset,
  ServiceDefinition,
} from '@infrasim/shared-types';

export const RUNTIME_PRESET_SPECS: Record<
  RuntimePreset,
  { label: string; maxInFlight: number; defaultCpuMs: number; singleCoreByDefault?: boolean }
> = {
  node: {
    label: 'Node.js (single process)',
    maxInFlight: 1000,
    defaultCpuMs: 4,
    singleCoreByDefault: true,
  },
  'php-fpm': { label: 'PHP-FPM (pm.max_children)', maxInFlight: 20, defaultCpuMs: 7 },
  'java-threads': { label: 'JVM thread pool', maxInFlight: 200, defaultCpuMs: 5 },
  'python-gunicorn': { label: 'Python Gunicorn (4×2)', maxInFlight: 8, defaultCpuMs: 8 },
  go: { label: 'Go goroutines', maxInFlight: 10000, defaultCpuMs: 2 },
  custom: { label: 'Custom runtime', maxInFlight: 100, defaultCpuMs: 4 },
};

export interface EffectiveServiceDefaults {
  instances: number;
  vcpu: number;
  memoryGb: number;
  runtimePreset: RuntimePreset;
  maxInFlightPerInstance: number;
  cpuMsPerRequest: number;
  queueMaxLength: number;
  queuePolicy: 'reject' | 'drop-oldest';
  timeoutMs: number;
  latency: LatencyModel;
  errorRate: number;
  rateLimitRps?: number;
  rateLimitBurst?: number;
  connectionsMax?: number;
  cacheHitRatio?: number;
  readRatio?: number;
  writeLatencyMultiplier?: number;
  connectionWaitMs?: number;
  coldStart?: {
    enabled: boolean;
    probabilityModel: 'idle-based' | 'fixed';
    p50: number;
    p95: number;
    idleTtlS: number;
  };
}

/** Derives canonical per-service defaults for NodeConfig fields and reset-to-default checks. */
export function getEffectiveServiceDefaults(service?: ServiceDefinition): EffectiveServiceDefaults {
  const cap = service?.capacity;
  const kind = service?.kind ?? 'compute';
  const runtimePreset: RuntimePreset =
    kind === 'compute' ? 'node' : kind === 'fn' ? 'node' : 'custom';

  let maxInFlightPerInstance = RUNTIME_PRESET_SPECS[runtimePreset].maxInFlight;
  if (cap?.type === 'conc') {
    maxInFlightPerInstance = cap.limit;
  } else if (kind === 'cache') {
    maxInFlightPerInstance = 500;
  } else if (kind === 'lb' || kind === 'gw' || kind === 'cdn' || kind === 'dns' || kind === 'net') {
    maxInFlightPerInstance = 1000;
  } else if (kind === 'sql' || kind === 'doc' || kind === 'graph' || kind === 'olap') {
    maxInFlightPerInstance = cap?.type === 'conn' ? cap.default : 100;
  }

  const defaultCpuMs =
    kind === 'compute' ? 4 : kind === 'fn' ? 3 : kind === 'cache' ? 0.2 : kind === 'sql' ? 2 : 1;

  return {
    instances: 1,
    vcpu: 2,
    memoryGb: 4,
    runtimePreset,
    maxInFlightPerInstance,
    cpuMsPerRequest: defaultCpuMs,
    queueMaxLength: 1000,
    queuePolicy: 'reject',
    timeoutMs: (service?.maxTimeoutS ?? 30) * 1000,
    latency: service?.latency ?? { distribution: 'lognormal', p50: 20, p95: 80 },
    errorRate: service?.failure.errorRate ?? 0.0005,
    rateLimitRps: cap?.type === 'rps' ? cap.limit : undefined,
    rateLimitBurst: cap?.type === 'rps' ? (cap.burst ?? Math.round(cap.limit * 0.5)) : undefined,
    connectionsMax: cap?.type === 'conn' ? cap.default : undefined,
    cacheHitRatio: kind === 'cache' ? 0.85 : kind === 'cdn' ? 0.9 : undefined,
    readRatio: kind === 'sql' || kind === 'kv' || kind === 'doc' ? 0.8 : undefined,
    writeLatencyMultiplier: kind === 'sql' || kind === 'kv' || kind === 'doc' ? 1.5 : undefined,
    connectionWaitMs: kind === 'sql' ? 500 : undefined,
    coldStart: service?.coldStart
      ? {
          enabled: true,
          probabilityModel: 'idle-based',
          p50: service.coldStart.p50,
          p95: service.coldStart.p95,
          idleTtlS: service.coldStart.idleTtlS,
        }
      : undefined,
  };
}

/** Computes theoretical max sustainable RPS for a node based on effective capacity knobs. */
export function computeTheoreticalMaxRps(
  config: NodeConfig,
  service?: ServiceDefinition,
): { rps: number | null; limitingFactor: string; explanation: string } {
  const defaults = getEffectiveServiceDefaults(service);
  const instances = Math.max(1, config.instances ?? defaults.instances);
  const cap = service?.capacity;

  if (cap?.type === 'passthrough') {
    return {
      rps: null,
      limitingFactor: 'Pass-through',
      explanation: 'Network pass-through nodes forward packets without slot or RPS queuing caps.',
    };
  }

  if (cap?.type === 'elastic' && !config.rateLimit?.rps) {
    return {
      rps: null,
      limitingFactor: 'Elastic scaling',
      explanation:
        'Elastic managed service scales capacity automatically unless a rate limit is configured.',
    };
  }

  const latency = config.latency ?? defaults.latency;
  const p50Sec = Math.max(0.0001, latency.p50 / 1000);
  const candidates: { rps: number; label: string; detail: string }[] = [];

  if (
    cap?.type === 'slots' ||
    cap?.type === 'conc' ||
    config.maxInFlightPerInstance !== undefined
  ) {
    const inFlight = config.maxInFlightPerInstance ?? defaults.maxInFlightPerInstance;
    const slotBound = (instances * inFlight) / p50Sec;
    candidates.push({
      rps: slotBound,
      label: 'Concurrency slots',
      detail: `${instances} instance${instances === 1 ? '' : 's'} × ${inFlight} slots / ${(p50Sec * 1000).toFixed(1)} ms p50 = ${Math.round(slotBound)} RPS`,
    });
  }

  if (service?.kind === 'compute' || service?.kind === 'fn') {
    const preset = config.runtimePreset ?? defaults.runtimePreset;
    const rawVcpu = config.vcpu ?? defaults.vcpu;
    const effectiveCores = preset === 'node' && !config.cluster ? Math.min(1, rawVcpu) : rawVcpu;
    const cpuMs = config.cpuMsPerRequest ?? defaults.cpuMsPerRequest;
    if (cpuMs > 0) {
      const cpuBound = instances * effectiveCores * (1000 / cpuMs);
      candidates.push({
        rps: cpuBound,
        label: 'CPU cores',
        detail: `${instances} × ${effectiveCores} eff. core${effectiveCores === 1 ? '' : 's'} / ${cpuMs} ms CPU time = ${Math.round(cpuBound)} RPS`,
      });
    }
  }

  if (cap?.type === 'conn' || config.connections?.max !== undefined) {
    const maxConn = config.connections?.max ?? defaults.connectionsMax ?? 100;
    const connBound = maxConn / p50Sec;
    candidates.push({
      rps: connBound,
      label: 'Connection pool',
      detail: `${maxConn} max connections / ${(p50Sec * 1000).toFixed(1)} ms p50 = ${Math.round(connBound)} RPS`,
    });
  }

  const effectiveRpsLimit = config.rateLimit?.rps ?? defaults.rateLimitRps;
  if (effectiveRpsLimit !== undefined && effectiveRpsLimit > 0) {
    candidates.push({
      rps: effectiveRpsLimit,
      label: 'Rate limit',
      detail: `Configured throttle cap at ${effectiveRpsLimit} RPS`,
    });
  }

  if (candidates.length === 0) {
    return {
      rps: null,
      limitingFactor: 'Uncapped',
      explanation: 'No explicit concurrency or RPS limit configured.',
    };
  }

  candidates.sort((a, b) => a.rps - b.rps);
  const bottleneck = candidates[0]!;
  return {
    rps: Math.max(1, Math.round(bottleneck.rps)),
    limitingFactor: bottleneck.label,
    explanation: `${bottleneck.label}: ${bottleneck.detail}`,
  };
}

/** Creates an initial minimal NodeConfig anchored cleanly on catalog defaults. */
export function createInitialNodeConfig(service?: ServiceDefinition): NodeConfig {
  return {
    instances: 1,
    operations: {},
    ...(service?.kind === 'compute'
      ? { vcpu: 2, memoryGb: 4, runtimePreset: 'node' as const }
      : {}),
  };
}
