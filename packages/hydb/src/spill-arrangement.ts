import { estimateMemoryBytes } from "./memory.js";
import type { SpillCodec } from "./spill-sort.js";
import type { SpillRun, SpillSession } from "./spill.js";

export type ArrangementChange<Value> = Readonly<{
  id: string;
  value: Value;
  diff: number;
}>;

type Entry<Value> = Readonly<{
  key: string;
  id: string;
  value: Value;
  diff: number;
}>;

function partitionFor(key: string, partitions: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & (partitions - 1);
}

function encodeEntry<Value>(
  entry: Entry<Value>,
  codec: SpillCodec<Value>,
): Uint8Array {
  const key = new TextEncoder().encode(entry.key);
  const id = new TextEncoder().encode(entry.id);
  const value = codec.encode(entry.value);
  const output = new Uint8Array(
    12 + key.byteLength + id.byteLength + value.byteLength,
  );
  const view = new DataView(output.buffer);
  view.setUint32(0, key.byteLength);
  view.setUint32(4, id.byteLength);
  view.setInt32(8, entry.diff);
  output.set(key, 12);
  output.set(id, 12 + key.byteLength);
  output.set(value, 12 + key.byteLength + id.byteLength);
  return output;
}

function decodeEntry<Value>(
  bytes: Uint8Array,
  codec: SpillCodec<Value>,
): Entry<Value> {
  if (bytes.byteLength < 12) throw new TypeError("Invalid arrangement entry");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keyBytes = view.getUint32(0);
  const idBytes = view.getUint32(4);
  const valueOffset = 12 + keyBytes + idBytes;
  if (valueOffset > bytes.byteLength) {
    throw new TypeError("Invalid arrangement entry lengths");
  }
  return {
    key: new TextDecoder().decode(bytes.subarray(12, 12 + keyBytes)),
    id: new TextDecoder().decode(bytes.subarray(12 + keyBytes, valueOffset)),
    diff: view.getInt32(8),
    value: codec.decode(bytes.subarray(valueOffset)),
  };
}

export class SpillableArrangement<Value> {
  readonly #records = new Map<string, Value>();
  readonly #buckets = new Map<string, Set<string>>();
  readonly #hot: Entry<Value>[] = [];
  readonly #runs = new Map<number, SpillRun[]>();
  readonly #partitions: number;
  #hotBytes = 0;
  #spilled = false;

  get residentBytes(): number {
    return this.#hotBytes;
  }

  constructor(
    private readonly keyOf: (value: Value) => string,
    private readonly codec: SpillCodec<Value>,
    private readonly limitBytes: number,
    private readonly session: () => Promise<SpillSession>,
    partitions = 16,
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new TypeError(
        "Arrangement memoryBytes must be a positive safe integer",
      );
    }
    if (
      !Number.isSafeInteger(partitions) ||
      partitions < 2 ||
      (partitions & (partitions - 1)) !== 0
    ) {
      throw new TypeError("Arrangement partitions must be a power of two");
    }
    this.#partitions = partitions;
  }

  async apply(changes: readonly ArrangementChange<Value>[]): Promise<void> {
    if (!this.#spilled) {
      for (const change of changes) this.applyMemory(change);
      if (this.#hotBytes > this.limitBytes) await this.spillSnapshot();
      return;
    }
    for (const change of changes) {
      const entry = { ...change, key: this.keyOf(change.value) };
      this.#hot.push(entry);
      this.#hotBytes += estimateMemoryBytes(entry) + 64;
    }
    if (this.#hotBytes >= this.limitBytes) await this.flushHot();
  }

  async lookup(key: string): Promise<readonly [string, Value][]> {
    if (!this.#spilled) {
      const values: [string, Value][] = [];
      for (const id of this.#buckets.get(key) ?? []) {
        const value = this.#records.get(id);
        if (value !== undefined) values.push([id, value]);
      }
      return values;
    }
    const values = new Map<string, Value>();
    const session = await this.session();
    const partition = partitionFor(key, this.#partitions);
    for (const run of this.#runs.get(partition) ?? []) {
      for await (const bytes of session.readRun(run)) {
        const entry = decodeEntry(bytes, this.codec);
        if (entry.key !== key) continue;
        if (entry.diff < 0) values.delete(entry.id);
        else values.set(entry.id, entry.value);
      }
    }
    for (const entry of this.#hot) {
      if (entry.key !== key) continue;
      if (entry.diff < 0) values.delete(entry.id);
      else values.set(entry.id, entry.value);
    }
    return [...values];
  }

  private applyMemory(change: ArrangementChange<Value>): void {
    const key = this.keyOf(change.value);
    if (change.diff < 0) {
      this.#records.delete(change.id);
      const bucket = this.#buckets.get(key);
      bucket?.delete(change.id);
      if (bucket?.size === 0) this.#buckets.delete(key);
    } else {
      this.#records.set(change.id, change.value);
      const bucket = this.#buckets.get(key) ?? new Set<string>();
      bucket.add(change.id);
      this.#buckets.set(key, bucket);
    }
    this.#hotBytes = this.#records.size * 112 + this.#buckets.size * 48;
  }

  private async spillSnapshot(): Promise<void> {
    this.#spilled = true;
    for (const [id, value] of this.#records) {
      this.#hot.push({ id, value, diff: 1, key: this.keyOf(value) });
    }
    this.#records.clear();
    this.#buckets.clear();
    await this.flushHot();
  }

  private async flushHot(): Promise<void> {
    const byPartition = new Map<number, Entry<Value>[]>();
    for (const entry of this.#hot) {
      const partition = partitionFor(entry.key, this.#partitions);
      const entries = byPartition.get(partition) ?? [];
      entries.push(entry);
      byPartition.set(partition, entries);
    }
    const session = await this.session();
    for (const [partition, entries] of byPartition) {
      const run = await session.writeRun(
        "arrangement",
        entries.map((entry) => encodeEntry(entry, this.codec)),
      );
      const runs = this.#runs.get(partition) ?? [];
      runs.push(run);
      this.#runs.set(partition, runs);
    }
    this.#hot.length = 0;
    this.#hotBytes = 0;
  }
}
