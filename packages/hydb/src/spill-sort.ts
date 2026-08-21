import { estimateMemoryBytes } from "./memory.js";
import type { SpillRun, SpillSession } from "./spill.js";

export type SpillCodec<Value> = Readonly<{
  encode(value: Value): Uint8Array;
  decode(bytes: Uint8Array): Value;
}>;

export class SpillableSorter<Value> {
  readonly #buffer: Value[] = [];
  readonly #runs: SpillRun[] = [];
  #bufferBytes = 0;
  #finished = false;

  constructor(
    private readonly compare: (left: Value, right: Value) => number,
    private readonly codec: SpillCodec<Value>,
    private readonly memoryBytes: number,
    private readonly session: () => Promise<SpillSession>,
  ) {
    if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
      throw new TypeError("Sort memoryBytes must be a positive safe integer");
    }
  }

  async push(value: Value): Promise<void> {
    if (this.#finished) throw new Error("Sort input is already finished");
    const bytes = estimateMemoryBytes(value) + 64;
    if (
      this.#buffer.length > 0 &&
      this.#bufferBytes + bytes > this.memoryBytes
    ) {
      await this.spillBuffer();
    }
    this.#buffer.push(value);
    this.#bufferBytes += bytes;
    if (this.#bufferBytes > this.memoryBytes) await this.spillBuffer();
  }

  async *finish(): AsyncIterable<Value> {
    if (this.#finished) throw new Error("Sort input is already finished");
    this.#finished = true;
    if (this.#runs.length === 0) {
      this.#buffer.sort(this.compare);
      yield* this.#buffer;
      this.#buffer.length = 0;
      this.#bufferBytes = 0;
      return;
    }
    if (this.#buffer.length > 0) await this.spillBuffer();
    yield* this.mergeRuns();
  }

  private async spillBuffer(): Promise<void> {
    this.#buffer.sort(this.compare);
    const session = await this.session();
    this.#runs.push(
      await session.writeRun(
        "sort",
        this.#buffer.map((value) => this.codec.encode(value)),
      ),
    );
    this.#buffer.length = 0;
    this.#bufferBytes = 0;
  }

  private async *mergeRuns(): AsyncIterable<Value> {
    const session = await this.session();
    const iterators = this.#runs.map((run) =>
      session.readRun(run)[Symbol.asyncIterator](),
    );
    const heads = await Promise.all(
      iterators.map((iterator) => iterator.next()),
    );
    try {
      while (true) {
        let selected = -1;
        for (let index = 0; index < heads.length; index += 1) {
          const head = heads[index]!;
          if (head.done) continue;
          if (
            selected === -1 ||
            this.compare(
              this.codec.decode(head.value),
              this.codec.decode(heads[selected]!.value),
            ) < 0
          ) {
            selected = index;
          }
        }
        if (selected === -1) return;
        const head = heads[selected]!;
        yield this.codec.decode(head.value);
        heads[selected] = await iterators[selected]!.next();
      }
    } finally {
      await Promise.all(iterators.map((iterator) => iterator.return?.()));
    }
  }
}
