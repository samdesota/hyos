import { estimateMemoryBytes } from "./memory.js";
import type { SpillCodec } from "./spill-sort.js";
import type { SpillRun, SpillSession } from "./spill.js";

type Entry<Value> = Readonly<{ key: string; value: Value }>;

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
  const value = codec.encode(entry.value);
  const output = new Uint8Array(4 + key.byteLength + value.byteLength);
  new DataView(output.buffer).setUint32(0, key.byteLength);
  output.set(key, 4);
  output.set(value, 4 + key.byteLength);
  return output;
}

function decodeEntry<Value>(
  bytes: Uint8Array,
  codec: SpillCodec<Value>,
): Entry<Value> {
  if (bytes.byteLength < 4) throw new TypeError("Invalid spilled hash entry");
  const keyBytes = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0);
  if (4 + keyBytes > bytes.byteLength) {
    throw new TypeError("Invalid spilled hash key length");
  }
  return {
    key: new TextDecoder().decode(bytes.subarray(4, 4 + keyBytes)),
    value: codec.decode(bytes.subarray(4 + keyBytes)),
  };
}

export class SpillableHashIndex<Value> {
  readonly #memory = new Map<string, Value[]>();
  readonly #buffer: Entry<Value>[] = [];
  readonly #runs = new Map<number, SpillRun[]>();
  readonly #partitions: number;
  #memoryBytes = 0;
  #finished = false;
  #spilled = false;

  constructor(
    private readonly codec: SpillCodec<Value>,
    private readonly limitBytes: number,
    private readonly session: () => Promise<SpillSession>,
    partitions = 16,
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new TypeError(
        "Hash index memoryBytes must be a positive safe integer",
      );
    }
    if (
      !Number.isSafeInteger(partitions) ||
      partitions < 2 ||
      (partitions & (partitions - 1)) !== 0
    ) {
      throw new TypeError("Hash partitions must be a power of two");
    }
    this.#partitions = partitions;
  }

  async push(key: string, value: Value): Promise<void> {
    if (this.#finished) throw new Error("Hash index input is already finished");
    const bytes = estimateMemoryBytes(key) + estimateMemoryBytes(value) + 96;
    if (!this.#spilled && this.#memoryBytes + bytes <= this.limitBytes) {
      const values = this.#memory.get(key) ?? [];
      values.push(value);
      this.#memory.set(key, values);
      this.#memoryBytes += bytes;
      return;
    }
    if (!this.#spilled) {
      this.#spilled = true;
      for (const [storedKey, values] of this.#memory) {
        for (const stored of values) {
          this.#buffer.push({ key: storedKey, value: stored });
        }
      }
      this.#memory.clear();
      this.#memoryBytes = 0;
    }
    this.#buffer.push({ key, value });
    this.#memoryBytes += bytes;
    if (this.#memoryBytes >= this.limitBytes) await this.flush();
  }

  async finish(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#spilled && this.#buffer.length > 0) await this.flush();
  }

  async *lookup(key: string): AsyncIterable<Value> {
    if (!this.#finished) throw new Error("Hash index input is not finished");
    if (!this.#spilled) {
      yield* this.#memory.get(key) ?? [];
      return;
    }
    const session = await this.session();
    const partition = partitionFor(key, this.#partitions);
    for (const run of this.#runs.get(partition) ?? []) {
      for await (const bytes of session.readRun(run)) {
        const entry = decodeEntry(bytes, this.codec);
        if (entry.key === key) yield entry.value;
      }
    }
  }

  private async flush(): Promise<void> {
    const byPartition = new Map<number, Entry<Value>[]>();
    for (const entry of this.#buffer) {
      const partition = partitionFor(entry.key, this.#partitions);
      const entries = byPartition.get(partition) ?? [];
      entries.push(entry);
      byPartition.set(partition, entries);
    }
    const session = await this.session();
    for (const [partition, entries] of byPartition) {
      const run = await session.writeRun(
        "hash",
        entries.map((entry) => encodeEntry(entry, this.codec)),
      );
      const runs = this.#runs.get(partition) ?? [];
      runs.push(run);
      this.#runs.set(partition, runs);
    }
    this.#buffer.length = 0;
    this.#memoryBytes = 0;
  }
}
