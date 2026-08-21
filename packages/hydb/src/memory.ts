export type MemoryStats = Readonly<{
  maxBytes: number;
  usedBytes: number;
  availableBytes: number;
  overBudgetBytes: number;
  allocations: number;
  evictions: number;
  reclaimedBytes: number;
  byOwner: Readonly<Record<string, number>>;
}>;

export type MemoryAllocation = Readonly<{
  owner: string;
  bytes?: number;
  priority?: number;
  reclaim?: (targetBytes: number) => number;
}>;

export interface MemoryHandle {
  readonly bytes: number;
  resize(bytes: number): void;
  touch(): void;
  pin(): void;
  unpin(): void;
  release(): void;
}

type AllocationEntry = {
  owner: string;
  bytes: number;
  priority: number;
  touched: number;
  pins: number;
  reclaim?: (targetBytes: number) => number;
};

function assertBytes(bytes: number, name: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

export class MemoryLimitExceededError extends Error {
  constructor(
    readonly requestedBytes: number,
    readonly availableBytes: number,
  ) {
    super(
      `Memory reservation of ${requestedBytes} bytes exceeds the ${availableBytes} bytes available`,
    );
    this.name = "MemoryLimitExceededError";
  }
}

/** Coordinates a soft budget for retained state and hard, up-front reservations. */
export class MemoryManager {
  readonly #entries = new Map<number, AllocationEntry>();
  #maxBytes: number;
  #nextId = 0;
  #clock = 0;
  #usedBytes = 0;
  #evictions = 0;
  #reclaimedBytes = 0;

  constructor(options: { maxBytes: number }) {
    assertBytes(options.maxBytes, "Memory maxBytes");
    this.#maxBytes = options.maxBytes;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  setMaxBytes(maxBytes: number): void {
    assertBytes(maxBytes, "Memory maxBytes");
    this.#maxBytes = maxBytes;
    this.reclaimToBudget();
  }

  reclaim(bytes: number): number {
    assertBytes(bytes, "Reclaim bytes");
    return this.reclaimTo(bytes);
  }

  track(allocation: MemoryAllocation): MemoryHandle {
    return this.add(allocation, false);
  }

  reserve(allocation: Omit<MemoryAllocation, "reclaim">): MemoryHandle {
    const bytes = allocation.bytes ?? 0;
    assertBytes(bytes, "Allocation bytes");
    this.reclaimTo(Math.max(0, this.#usedBytes + bytes - this.#maxBytes));
    const available = Math.max(0, this.#maxBytes - this.#usedBytes);
    if (bytes > available) {
      throw new MemoryLimitExceededError(bytes, available);
    }
    return this.add(allocation, true);
  }

  stats(): MemoryStats {
    const byOwner: Record<string, number> = {};
    for (const entry of this.#entries.values()) {
      byOwner[entry.owner] = (byOwner[entry.owner] ?? 0) + entry.bytes;
    }
    const overBudgetBytes = Math.max(0, this.#usedBytes - this.#maxBytes);
    return Object.freeze({
      maxBytes: this.#maxBytes,
      usedBytes: this.#usedBytes,
      availableBytes: Math.max(0, this.#maxBytes - this.#usedBytes),
      overBudgetBytes,
      allocations: this.#entries.size,
      evictions: this.#evictions,
      reclaimedBytes: this.#reclaimedBytes,
      byOwner: Object.freeze(byOwner),
    });
  }

  private add(allocation: MemoryAllocation, reserved: boolean): MemoryHandle {
    const bytes = allocation.bytes ?? 0;
    assertBytes(bytes, "Allocation bytes");
    if (!Number.isFinite(allocation.priority ?? 0)) {
      throw new TypeError("Allocation priority must be finite");
    }
    const id = this.#nextId++;
    const entry: AllocationEntry = {
      owner: allocation.owner,
      bytes,
      priority: allocation.priority ?? 0,
      touched: this.#clock++,
      pins: reserved || allocation.reclaim === undefined ? 1 : 0,
      ...(allocation.reclaim === undefined
        ? {}
        : { reclaim: allocation.reclaim }),
    };
    this.#entries.set(id, entry);
    this.#usedBytes += bytes;
    if (!reserved) this.reclaimToBudget();

    let released = false;
    const current = (): AllocationEntry | undefined =>
      released ? undefined : this.#entries.get(id);
    return {
      get bytes() {
        return current()?.bytes ?? 0;
      },
      resize: (nextBytes) => {
        assertBytes(nextBytes, "Allocation bytes");
        const active = current();
        if (active === undefined) return;
        this.#usedBytes += nextBytes - active.bytes;
        active.bytes = nextBytes;
        active.touched = this.#clock++;
        this.reclaimToBudget();
      },
      touch: () => {
        const active = current();
        if (active !== undefined) active.touched = this.#clock++;
      },
      pin: () => {
        const active = current();
        if (active !== undefined) active.pins += 1;
      },
      unpin: () => {
        const active = current();
        if (active === undefined || active.pins === 0) return;
        active.pins -= 1;
        this.reclaimToBudget();
      },
      release: () => {
        const active = current();
        if (active === undefined) return;
        released = true;
        this.#entries.delete(id);
        this.#usedBytes -= active.bytes;
      },
    };
  }

  private reclaimToBudget(): void {
    this.reclaimTo(Math.max(0, this.#usedBytes - this.#maxBytes));
  }

  private reclaimTo(targetBytes: number): number {
    let remaining = targetBytes;
    const candidates = [...this.#entries.values()]
      .filter((entry) => entry.pins === 0 && entry.reclaim !== undefined)
      .sort(
        (left, right) =>
          left.priority - right.priority || left.touched - right.touched,
      );
    for (const entry of candidates) {
      if (remaining <= 0) break;
      const requested = Math.min(remaining, entry.bytes);
      const reported = entry.reclaim!(requested);
      if (!Number.isSafeInteger(reported) || reported < 0) {
        throw new TypeError("Memory reclaimer must return non-negative bytes");
      }
      const reclaimed = Math.min(reported, entry.bytes);
      if (reclaimed === 0) continue;
      entry.bytes -= reclaimed;
      this.#usedBytes -= reclaimed;
      this.#reclaimedBytes += reclaimed;
      this.#evictions += 1;
      remaining -= reclaimed;
    }
    return targetBytes - remaining;
  }
}

/** Conservative heap estimate used for logical rows and query values. */
export function estimateMemoryBytes(value: unknown): number {
  const seen = new WeakSet<object>();
  const visit = (current: unknown): number => {
    switch (typeof current) {
      case "undefined":
      case "boolean":
      case "number":
      case "bigint":
        return 8;
      case "string":
        return 16 + current.length * 2;
      case "symbol":
      case "function":
        return 32;
      case "object": {
        if (current === null) return 8;
        if (seen.has(current)) return 0;
        seen.add(current);
        if (current instanceof Date) return 24;
        if (current instanceof Uint8Array) return 32 + current.byteLength;
        if (Array.isArray(current)) {
          return 32 + current.reduce((bytes, item) => bytes + visit(item), 0);
        }
        if (current instanceof Map) {
          let bytes = 48;
          for (const [key, item] of current)
            bytes += 48 + visit(key) + visit(item);
          return bytes;
        }
        if (current instanceof Set) {
          let bytes = 48;
          for (const item of current) bytes += 32 + visit(item);
          return bytes;
        }
        let bytes = 48;
        for (const key of Reflect.ownKeys(current)) {
          bytes += 16 + (typeof key === "string" ? key.length * 2 : 8);
          bytes += visit((current as Record<PropertyKey, unknown>)[key]);
        }
        return bytes;
      }
    }
  };
  return Math.max(0, Math.ceil(visit(value)));
}
