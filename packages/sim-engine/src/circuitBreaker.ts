/** Per-edge circuit breaker state machine (`closed` -> `open` -> `half-open`). */
export interface CircuitBreakerState {
  edgeId: string;
  failureThreshold: number;
  windowMs: number;
  openMs: number;
  state: 'closed' | 'open' | 'half-open';
  failureTimestamps: number[];
  openedAtMs: number;
  probeInFlight: boolean;
}

/** Creates an initialized closed circuit breaker for an edge. */
export function createCircuitBreaker(
  edgeId: string,
  config: { failureThreshold: number; windowMs: number; openMs: number },
): CircuitBreakerState {
  return {
    edgeId,
    failureThreshold: Math.max(1, config.failureThreshold),
    windowMs: Math.max(100, config.windowMs),
    openMs: Math.max(50, config.openMs),
    state: 'closed',
    failureTimestamps: [],
    openedAtMs: 0,
    probeInFlight: false,
  };
}

/** Checks whether an outgoing request is permitted through the circuit breaker at `nowMs`. */
export function allowCircuitBreakerRequest(cb: CircuitBreakerState, nowMs: number): boolean {
  if (cb.state === 'closed') {
    return true;
  }
  if (cb.state === 'open') {
    if (nowMs - cb.openedAtMs >= cb.openMs) {
      cb.state = 'half-open';
      cb.probeInFlight = true;
      return true;
    }
    return false;
  }
  // half-open: permit one concurrent probe at a time
  if (!cb.probeInFlight) {
    cb.probeInFlight = true;
    return true;
  }
  return false;
}

/** Records a completed request outcome (`ok` or `failed`) onto the circuit breaker state. */
export function recordCircuitBreakerOutcome(
  cb: CircuitBreakerState,
  ok: boolean,
  nowMs: number,
): void {
  if (cb.state === 'half-open') {
    cb.probeInFlight = false;
    if (ok) {
      cb.state = 'closed';
      cb.failureTimestamps.length = 0;
    } else {
      cb.state = 'open';
      cb.openedAtMs = nowMs;
    }
    return;
  }

  if (cb.state === 'open') {
    return;
  }

  if (ok) {
    return;
  }

  const cutoff = nowMs - cb.windowMs;
  while (cb.failureTimestamps.length > 0 && cb.failureTimestamps[0]! < cutoff) {
    cb.failureTimestamps.shift();
  }
  cb.failureTimestamps.push(nowMs);

  if (cb.failureTimestamps.length >= cb.failureThreshold) {
    cb.state = 'open';
    cb.openedAtMs = nowMs;
    cb.failureTimestamps.length = 0;
  }
}
