/** Generic binary min-heap for deterministic DES event ordering. */
export class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  /** Number of buffered elements in the heap. */
  get size(): number {
    return this.items.length;
  }

  /** Returns true when the heap has no items remaining. */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** Peeks at the smallest item without removing it. */
  peek(): T | undefined {
    return this.items[0];
  }

  /** Inserts an item into the min-heap in `O(log n)`. */
  push(item: T): void {
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  /** Extracts and returns the smallest item in `O(log n)`. */
  pop(): T | undefined {
    const count = this.items.length;
    if (count === 0) {
      return undefined;
    }
    const root = this.items[0]!;
    const last = this.items.pop()!;
    if (count > 1) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return root;
  }

  /** Empties the heap. */
  clear(): void {
    this.items.length = 0;
  }

  private siftUp(index: number): void {
    let idx = index;
    const item = this.items[idx]!;
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      const parent = this.items[parentIdx]!;
      if (this.compare(item, parent) >= 0) {
        break;
      }
      this.items[idx] = parent;
      idx = parentIdx;
    }
    this.items[idx] = item;
  }

  private siftDown(index: number): void {
    let idx = index;
    const count = this.items.length;
    const item = this.items[idx]!;
    const half = count >> 1;

    while (idx < half) {
      let bestIdx = (idx << 1) + 1;
      let best = this.items[bestIdx]!;
      const rightIdx = bestIdx + 1;
      if (rightIdx < count && this.compare(this.items[rightIdx]!, best) < 0) {
        bestIdx = rightIdx;
        best = this.items[rightIdx]!;
      }
      if (this.compare(item, best) <= 0) {
        break;
      }
      this.items[idx] = best;
      idx = bestIdx;
    }
    this.items[idx] = item;
  }
}
