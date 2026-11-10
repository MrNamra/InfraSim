const LOG_BASE = 1.02;
const INV_LN_BASE = 1 / Math.log(LOG_BASE);
const MIN_VALUE_MS = 0.01;
const NUM_BUCKETS = 960; // Covers 0.01 ms up to > 1,800,000 ms (30 min)

/**
 * Memory-bounded mergeable base-1.02 logarithmic histogram (~2% relative error)
 * supporting O(1) recording and guaranteed monotonic percentile extraction.
 */
export class LogHistogram {
  readonly counts = new Uint32Array(NUM_BUCKETS);
  totalCount = 0;

  private indexFor(valueMs: number): number {
    const safe = Number.isFinite(valueMs) && valueMs > MIN_VALUE_MS ? valueMs : MIN_VALUE_MS;
    const raw = Math.floor(Math.log(safe / MIN_VALUE_MS) * INV_LN_BASE);
    if (raw < 0) return 0;
    if (raw >= NUM_BUCKETS) return NUM_BUCKETS - 1;
    return raw;
  }

  private valueFor(index: number): number {
    // Geometric midpoint of bucket `[index, index + 1)`
    return MIN_VALUE_MS * Math.pow(LOG_BASE, index + 0.5);
  }

  /** Records a latency observation in milliseconds (`>= 0.01 ms`). */
  record(valueMs: number, weight = 1): void {
    const idx = this.indexFor(valueMs);
    this.counts[idx] = (this.counts[idx] ?? 0) + weight;
    this.totalCount += weight;
  }

  /** Merges another `LogHistogram` into this instance in place. */
  merge(other: LogHistogram): void {
    if (other.totalCount === 0) {
      return;
    }
    for (let i = 0; i < NUM_BUCKETS; i++) {
      const c = other.counts[i]!;
      if (c > 0) {
        this.counts[i] = (this.counts[i] ?? 0) + c;
      }
    }
    this.totalCount += other.totalCount;
  }

  /** Resets all buckets back to zero for reuse across 1-second windows. */
  clear(): void {
    this.counts.fill(0);
    this.totalCount = 0;
  }

  /** Extracts an approximate quantile (`0 <= q <= 1`) from recorded counts. */
  quantile(q: number): number {
    if (this.totalCount === 0) {
      return 0;
    }
    const clampedQ = Math.min(1, Math.max(0, q));
    const targetRank = Math.max(1, Math.ceil(this.totalCount * clampedQ));
    let running = 0;
    for (let i = 0; i < NUM_BUCKETS; i++) {
      running += this.counts[i]!;
      if (running >= targetRank) {
        return Number(this.valueFor(i).toFixed(3));
      }
    }
    return 0;
  }

  /** Returns ordered `{ p50, p95, p99 }` guaranteed `p50 <= p95 <= p99`. */
  percentiles(): { p50: number; p95: number; p99: number } {
    if (this.totalCount === 0) {
      return { p50: 0, p95: 0, p99: 0 };
    }
    const p50 = this.quantile(0.5);
    const p95 = Math.max(p50, this.quantile(0.95));
    const p99 = Math.max(p95, this.quantile(0.99));
    return { p50, p95, p99 };
  }
}
