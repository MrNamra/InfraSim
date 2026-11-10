const LOG_BASE = 1.02;
const INV_LN_BASE = 1 / Math.log(LOG_BASE);
const MIN_VALUE_MS = 0.01;
const NUM_BUCKETS = 960; // Covers 0.01 ms up to > 1,800,000 ms (30 min)

// Precomputed geometric bucket midpoints rounded to 3 decimals to avoid Math.pow per read
const BUCKET_VALUES = new Float64Array(NUM_BUCKETS);
for (let i = 0; i < NUM_BUCKETS; i++) {
  BUCKET_VALUES[i] = Number((MIN_VALUE_MS * Math.pow(LOG_BASE, i + 0.5)).toFixed(3));
}

/**
 * Memory-bounded mergeable base-1.02 logarithmic histogram (~2% relative error)
 * supporting O(1) recording and single-pass monotonic percentile extraction.
 */
export class LogHistogram {
  readonly counts = new Uint32Array(NUM_BUCKETS);
  totalCount = 0;
  private minIdx = NUM_BUCKETS;
  private maxIdx = -1;

  private indexFor(valueMs: number): number {
    const safe = Number.isFinite(valueMs) && valueMs > MIN_VALUE_MS ? valueMs : MIN_VALUE_MS;
    const raw = Math.floor(Math.log(safe / MIN_VALUE_MS) * INV_LN_BASE);
    if (raw < 0) return 0;
    if (raw >= NUM_BUCKETS) return NUM_BUCKETS - 1;
    return raw;
  }

  /** Records a latency observation in milliseconds (`>= 0.01 ms`). */
  record(valueMs: number, weight = 1): void {
    const idx = this.indexFor(valueMs);
    this.counts[idx] = (this.counts[idx] ?? 0) + weight;
    this.totalCount += weight;
    if (idx < this.minIdx) this.minIdx = idx;
    if (idx > this.maxIdx) this.maxIdx = idx;
  }

  /** Merges another `LogHistogram` into this instance in place. */
  merge(other: LogHistogram): void {
    if (other.totalCount === 0) {
      return;
    }
    const lo = Math.max(0, other.minIdx);
    const hi = Math.min(NUM_BUCKETS - 1, other.maxIdx);
    for (let i = lo; i <= hi; i++) {
      const c = other.counts[i]!;
      if (c > 0) {
        this.counts[i] = (this.counts[i] ?? 0) + c;
        if (i < this.minIdx) this.minIdx = i;
        if (i > this.maxIdx) this.maxIdx = i;
      }
    }
    this.totalCount += other.totalCount;
  }

  /** Resets all buckets back to zero for reuse across 1-second windows. */
  clear(): void {
    if (this.totalCount === 0) {
      return;
    }
    if (this.maxIdx >= this.minIdx) {
      this.counts.fill(0, this.minIdx, this.maxIdx + 1);
    }
    this.totalCount = 0;
    this.minIdx = NUM_BUCKETS;
    this.maxIdx = -1;
  }

  /** Extracts an approximate quantile (`0 <= q <= 1`) from recorded counts. */
  quantile(q: number): number {
    if (this.totalCount === 0) {
      return 0;
    }
    const clampedQ = Math.min(1, Math.max(0, q));
    const targetRank = Math.max(1, Math.ceil(this.totalCount * clampedQ));
    let running = 0;
    for (let i = this.minIdx; i <= this.maxIdx; i++) {
      running += this.counts[i]!;
      if (running >= targetRank) {
        return BUCKET_VALUES[i]!;
      }
    }
    return 0;
  }

  /** Returns ordered `{ p50, p95, p99 }` computed in a single sparse pass. */
  percentiles(): { p50: number; p95: number; p99: number } {
    if (this.totalCount === 0) {
      return { p50: 0, p95: 0, p99: 0 };
    }
    const r50 = Math.max(1, Math.ceil(this.totalCount * 0.5));
    const r95 = Math.max(r50, Math.ceil(this.totalCount * 0.95));
    const r99 = Math.max(r95, Math.ceil(this.totalCount * 0.99));

    let p50 = 0;
    let p95 = 0;
    let p99 = 0;
    let running = 0;

    for (let i = this.minIdx; i <= this.maxIdx; i++) {
      const c = this.counts[i]!;
      if (c === 0) continue;
      running += c;
      const val = BUCKET_VALUES[i]!;
      if (p50 === 0 && running >= r50) p50 = val;
      if (p95 === 0 && running >= r95) p95 = val;
      if (running >= r99) {
        p99 = val;
        break;
      }
    }

    p95 = Math.max(p50, p95);
    p99 = Math.max(p95, p99);
    return { p50, p95, p99 };
  }
}
