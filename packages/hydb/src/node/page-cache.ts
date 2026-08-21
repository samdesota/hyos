export type PageCacheStats = Readonly<{
  hits: number;
  misses: number;
  evictions: number;
  residentBytes: number;
  entries: number;
}>;

type Entry<Value> = { value: Value; bytes: number };

export class ByteLruCache<Key, Value> {
  readonly #entries = new Map<Key, Entry<Value>>();
  readonly #loading = new Map<Key, Promise<Value>>();
  #residentBytes = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(
    maxBytes: number,
    private readonly load: (key: Key) => Promise<Value>,
    private readonly weight: (value: Value) => number,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError("Cache maxBytes must be a non-negative safe integer");
    }
    this.#maxBytes = maxBytes;
  }

  #maxBytes: number;

  get maxBytes(): number {
    return this.#maxBytes;
  }

  async get(key: Key): Promise<Value> {
    const cached = this.#entries.get(key);
    if (cached !== undefined) {
      this.#hits += 1;
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      return cached.value;
    }

    const pending = this.#loading.get(key);
    if (pending !== undefined) {
      this.#hits += 1;
      return pending;
    }

    this.#misses += 1;
    const promise = this.load(key).then((value) => {
      const bytes = Math.max(0, this.weight(value));
      if (bytes <= this.#maxBytes) {
        this.#entries.set(key, { value, bytes });
        this.#residentBytes += bytes;
        this.evictToLimit();
      }
      return value;
    });
    this.#loading.set(key, promise);
    try {
      return await promise;
    } finally {
      this.#loading.delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#residentBytes = 0;
  }

  setMaxBytes(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError("Cache maxBytes must be a non-negative safe integer");
    }
    this.#maxBytes = maxBytes;
    this.evictToLimit();
  }

  reclaim(bytes: number): number {
    const before = this.#residentBytes;
    const target = Math.max(0, before - Math.max(0, bytes));
    while (this.#residentBytes > target) {
      if (!this.evictOldest()) break;
    }
    return before - this.#residentBytes;
  }

  stats(): PageCacheStats {
    return Object.freeze({
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      residentBytes: this.#residentBytes,
      entries: this.#entries.size,
    });
  }

  private evictToLimit(): void {
    while (this.#residentBytes > this.#maxBytes) {
      if (!this.evictOldest()) break;
    }
  }

  private evictOldest(): boolean {
    const oldest = this.#entries.entries().next().value as
      [Key, Entry<Value>] | undefined;
    if (oldest === undefined) return false;
    this.#entries.delete(oldest[0]);
    this.#residentBytes -= oldest[1].bytes;
    this.#evictions += 1;
    return true;
  }
}
