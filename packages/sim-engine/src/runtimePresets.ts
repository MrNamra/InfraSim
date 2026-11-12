import type { NodeInstance, RuntimePreset, ServiceDefinition } from '@infrasim/shared-types';

export interface SimRuntimePresetSpec {
  maxInFlightPerInstance: number;
  useAllVcpuByDefault: boolean;
}

/** Canonical runtime presets from spec 05 §2. */
export const SIM_RUNTIME_PRESETS: Record<RuntimePreset, SimRuntimePresetSpec> = {
  node: { maxInFlightPerInstance: 1000, useAllVcpuByDefault: false },
  'php-fpm': { maxInFlightPerInstance: 20, useAllVcpuByDefault: true },
  'java-threads': { maxInFlightPerInstance: 200, useAllVcpuByDefault: true },
  'python-gunicorn': { maxInFlightPerInstance: 8, useAllVcpuByDefault: true },
  go: { maxInFlightPerInstance: 10000, useAllVcpuByDefault: true },
  custom: { maxInFlightPerInstance: 100, useAllVcpuByDefault: true },
};

export interface ResolvedNodeCapacities {
  instances: number;
  slotsPerInstance: number;
  totalSlots: number;
  coresPerInstance: number;
  totalCores: number;
  /** Effective CPU execution multiplier (>1 when sub-1 vCPU scales execution time on 1 core). */
  cpuSpeedMultiplier: number;
  queueMaxLength: number;
  queuePolicy: 'reject' | 'drop-oldest';
  fnOnLimit?: 'throttle' | 'queue';
  connectionsMax: number | null;
  connectionWaitMs: number;
  rateLimitRps: number | null;
  rateLimitBurst: number;
  approximate: boolean;
}

function scaleCapacityInt(raw: number, factor: number): { value: number; relError: number } {
  if (factor <= 1) {
    return { value: Math.max(1, Math.round(raw)), relError: 0 };
  }
  const scaled = Math.max(1, Math.ceil(raw / factor));
  const reconstructed = scaled * factor;
  const relError = raw > 0 ? Math.abs(reconstructed - raw) / raw : 0;
  return { value: scaled, relError };
}

/**
 * Resolves effective concurrency slots, CPU cores, queue bounds, pool size, and rate limits
 * for a node, applying DES scale factor division when scaled mode is active.
 */
export function resolveNodeCapacities(
  node: NodeInstance,
  service: ServiceDefinition | undefined,
  scaleFactor = 1,
): ResolvedNodeCapacities {
  const cfg = node.config;
  const kind = service?.kind ?? 'compute';
  const instances = Math.max(1, Math.round(cfg.instances || 1));

  const presetKey: RuntimePreset =
    cfg.runtimePreset ?? (kind === 'compute' || kind === 'fn' ? 'node' : 'custom');
  const presetSpec = SIM_RUNTIME_PRESETS[presetKey];

  const isAiKind =
    kind === 'llm' ||
    kind === 'ml' ||
    kind === 'vision' ||
    kind === 'speech' ||
    kind === 'text-ai' ||
    kind === 'doc-ai' ||
    kind === 'bot';

  let slotsPerInstance = cfg.maxInFlightPerInstance;
  if (slotsPerInstance === undefined) {
    if (kind === 'fn') {
      slotsPerInstance =
        cfg.coldStart?.concurrencyLimit ??
        (service?.capacity.type === 'conc'
          ? service.capacity.limit
          : presetSpec.maxInFlightPerInstance);
    } else if (
      isAiKind &&
      cfg.rateLimit?.concurrency !== undefined &&
      cfg.rateLimit.concurrency > 0
    ) {
      slotsPerInstance = cfg.rateLimit.concurrency;
    } else if (service?.capacity.type === 'conc') {
      slotsPerInstance = service.capacity.limit;
    } else if (kind === 'compute') {
      slotsPerInstance = cfg.coldStart?.concurrencyLimit ?? presetSpec.maxInFlightPerInstance;
    } else if (
      kind === 'lb' ||
      kind === 'gw' ||
      kind === 'cdn' ||
      kind === 'dns' ||
      kind === 'net'
    ) {
      slotsPerInstance = 10000;
    } else if (kind === 'cache') {
      slotsPerInstance = 5000;
    } else if (kind === 'sql' || kind === 'doc' || kind === 'graph' || kind === 'olap') {
      slotsPerInstance =
        cfg.connections?.max ??
        (service?.capacity.type === 'conn' ? service.capacity.default : 100);
    } else if (kind === 'kv') {
      slotsPerInstance = 5000;
    } else if (kind === 'queue' || kind === 'topic' || kind === 'stream' || kind === 'bus') {
      slotsPerInstance = 10000;
    } else {
      slotsPerInstance = 1000;
    }
  }

  const rawTotalSlots = Math.max(1, instances * Math.max(1, slotsPerInstance));

  const fnOnLimit: 'throttle' | 'queue' | undefined =
    kind === 'fn'
      ? (cfg.coldStart?.onLimit ??
        (service?.capacity.type === 'conc' ? service.capacity.onLimit : undefined) ??
        'throttle')
      : undefined;

  const vcpu = Math.max(0.25, cfg.vcpu ?? 1);
  let coresPerInstance = 0;
  let rawTotalCores = 0;
  if (kind === 'compute') {
    if (presetKey === 'node' && !cfg.cluster) {
      coresPerInstance = Math.min(1, vcpu);
    } else {
      coresPerInstance = vcpu;
    }
    rawTotalCores = instances * coresPerInstance;
  } else if (kind === 'fn') {
    // Each serverless concurrent execution sandbox owns isolated compute capacity
    coresPerInstance = vcpu;
    rawTotalCores = rawTotalSlots * vcpu;
  }
  const cpuSpeedMultiplier = rawTotalCores > 0 && rawTotalCores < 1 ? 1 / rawTotalCores : 1;
  const discreteCores = rawTotalCores > 0 ? Math.max(1, Math.round(rawTotalCores)) : 0;

  let defaultQueue = 1000;
  if (kind === 'lb' || kind === 'gw') {
    defaultQueue = 10000;
  } else if (kind === 'sql' || kind === 'doc' || kind === 'graph') {
    defaultQueue = 500;
  } else if (kind === 'fn') {
    defaultQueue = fnOnLimit === 'throttle' ? 0 : 1000;
  }
  const rawQueueMax =
    kind === 'fn' && fnOnLimit === 'throttle' ? 0 : (cfg.queue?.maxLength ?? defaultQueue);

  let rawConnMax: number | null = null;
  if (cfg.connections?.max !== undefined) {
    rawConnMax = cfg.connections.max;
  } else if (service?.capacity.type === 'conn') {
    rawConnMax = service.capacity.default;
  } else if (kind === 'sql' || kind === 'doc') {
    rawConnMax = 100;
  }

  let rawRateLimitRps: number | null = null;
  let rawRateLimitBurst = 0;
  if (cfg.rateLimit?.rps !== undefined && cfg.rateLimit.rps > 0) {
    rawRateLimitRps = cfg.rateLimit.rps;
    rawRateLimitBurst = cfg.rateLimit.burst ?? Math.max(1, Math.round(cfg.rateLimit.rps * 0.5));
  } else if (service?.capacity.type === 'rps') {
    rawRateLimitRps = service.capacity.limit;
    rawRateLimitBurst =
      service.capacity.burst ?? Math.max(1, Math.round(service.capacity.limit * 0.5));
  }

  let approximate = false;
  const scaledSlots = scaleCapacityInt(rawTotalSlots, scaleFactor);
  approximate ||= scaledSlots.relError > 0.1;

  const scaledCores =
    discreteCores > 0 ? scaleCapacityInt(discreteCores, scaleFactor) : { value: 0, relError: 0 };
  approximate ||= scaledCores.relError > 0.1;

  const scaledQueue =
    rawQueueMax > 0 ? scaleCapacityInt(rawQueueMax, scaleFactor) : { value: 0, relError: 0 };
  approximate ||= scaledQueue.relError > 0.1;

  let connectionsMax: number | null = null;
  if (rawConnMax !== null) {
    const scaledConn = scaleCapacityInt(rawConnMax, scaleFactor);
    connectionsMax = scaledConn.value;
    approximate ||= scaledConn.relError > 0.1;
  }

  let rateLimitRps: number | null = null;
  let rateLimitBurst = 0;
  if (rawRateLimitRps !== null) {
    rateLimitRps = rawRateLimitRps / scaleFactor;
    rateLimitBurst = Math.max(1, Math.ceil(rawRateLimitBurst / scaleFactor));
  }

  return {
    instances,
    slotsPerInstance,
    totalSlots: scaledSlots.value,
    coresPerInstance,
    totalCores: scaledCores.value,
    cpuSpeedMultiplier,
    queueMaxLength: scaledQueue.value,
    queuePolicy: cfg.queue?.policy ?? 'reject',
    ...(fnOnLimit ? { fnOnLimit } : {}),
    connectionsMax,
    connectionWaitMs: cfg.connectionWaitMs ?? 5000,
    rateLimitRps,
    rateLimitBurst,
    approximate,
  };
}
