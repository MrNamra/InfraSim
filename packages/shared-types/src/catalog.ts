import type { Provider } from './network.js';

/** Latency sampling parameters anchored at p50 and p95 in milliseconds. */
export interface LatencyModel {
  distribution: 'lognormal' | 'fixed' | 'normal' | 'bimodal';
  p50: number;
  p95: number;
  mode2?: { weight: number; p50: number; p95: number };
}

/** Classification of simulated request failures. */
export type ErrorKind =
  | 'timeout'
  | 'throttled'
  | 'server'
  | 'conn_refused'
  | 'conn_timeout'
  | 'dropped_queue_full'
  | 'circuit_open'
  | 'user_code'
  | 'not_reachable';

/** Behavioral kind determining how the simulation engine handles a service node. */
export type MockKind =
  | 'compute'
  | 'fn'
  | 'lb'
  | 'gw'
  | 'cdn'
  | 'dns'
  | 'net'
  | 'object'
  | 'block'
  | 'file'
  | 'sql'
  | 'kv'
  | 'doc'
  | 'cache'
  | 'graph'
  | 'ts'
  | 'olap'
  | 'search'
  | 'queue'
  | 'topic'
  | 'stream'
  | 'bus'
  | 'workflow'
  | 'auth'
  | 'secret'
  | 'kms'
  | 'email'
  | 'async'
  | 'llm'
  | 'ml'
  | 'vision'
  | 'speech'
  | 'text-ai'
  | 'doc-ai'
  | 'bot';

/** Pricing dimension model code used by catalog tables and cost engine. */
export type PriceModel =
  | 'hr'
  | 'vcpu-gb-hr'
  | 'req'
  | 'fn'
  | 'gb-mo'
  | 'gb-xfer'
  | 'tok'
  | 'unit'
  | 'ru'
  | 'rcu-wcu'
  | 'shard-hr'
  | 'lcu'
  | 'msg'
  | 'query-tb'
  | 'acu-hr'
  | 'mau'
  | 'mix'
  | 'flat'
  | 'free';

/** Capacity behavior specification for a service catalog entry. */
export type CapacitySpec =
  | { type: 'elastic' }
  | { type: 'slots'; fromInstanceType: true }
  | { type: 'conc'; limit: number; onLimit: 'throttle' | 'queue' }
  | { type: 'rps'; limit: number; burst?: number }
  | { type: 'units'; read: number; write: number }
  | { type: 'conn'; formula?: string; default: number }
  | { type: 'tpm'; rpm?: number; tpm?: number }
  | { type: 'passthrough' };

/** Error specification defined on a service or operation. */
export interface ErrorKindDef {
  kind: ErrorKind;
  statusCode: number;
  name: string;
  message: string;
  defaultRate: number;
}

/** Quota specification listed in a catalog service entry. */
export interface QuotaSpec {
  name: string;
  limit: number;
  unit: string;
  notes?: string;
}

/** Operation supported by a service definition. */
export interface OperationDef {
  name: string;
  summary: string;
  latency?: LatencyModel;
  inputSchema?: Record<string, unknown>;
  defaultResponse: {
    statusCode: number;
    headers?: Record<string, string>;
    bodyTemplate: string;
    sizeBytes?: number;
  };
  errors: ErrorKindDef[];
  idempotent?: boolean;
  units?: { read?: number; write?: number };
}

/** Full catalog service entry parsed from specs and kind defaults. */
export interface ServiceDefinition {
  id: string;
  provider: Provider;
  name: string;
  category: string;
  kind: MockKind;
  description: string;
  scope: 'regional' | 'zonal' | 'global';
  latency: LatencyModel;
  capacity: CapacitySpec;
  coldStart?: { p50: number; p95: number; idleTtlS: number };
  scaleOutLagS?: number;
  maxTimeoutS?: number;
  failure: { errorRate: number; kinds: ErrorKindDef[] };
  limits?: QuotaSpec[];
  operations: OperationDef[];
  pricing: { model: PriceModel; skuKey?: string };
  equivalents?: Partial<Record<Provider, string>>;
  ports?: { protocol: string; port: number }[];
  tags?: string[];
  icon: string;
  docsUrl?: string;
  notes?: string;
}

/** User-created custom service definition embedded in a design or saved per user. */
export interface CustomServiceDefinition extends ServiceDefinition {
  ownerId?: string;
  color?: string;
  manualUnitPrice?: number;
  manualUnit?: string;
}

/** Saved per-node Latency & Mock preset created by the user. */
export interface CustomPreset {
  id: string;
  name: string;
  serviceId?: string;
  kind?: MockKind;
  latency?: LatencyModel;
  errorRate?: number;
  maxInFlightPerInstance?: number;
  rateLimit?: { rps?: number; burst?: number; tpm?: number; rpm?: number };
  timeoutMs?: number;
}
