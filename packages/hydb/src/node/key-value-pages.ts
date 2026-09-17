import type { KeyValueOperation, KeyValueStore } from "./key-value-store.js";
import type { PageId, TreePageStore } from "./tree-page-store.js";

export const pageKey = (id: PageId): string =>
  `page/${id.toString().padStart(16, "0")}`;
export const pageSizeKey = (key: string): string =>
  `page-size/${key.slice("page/".length)}`;

/** Only the writer's currently reachable, unpublished pages stay staged. */
export class KeyValuePages implements TreePageStore {
  private readonly pending = new Map<
    PageId,
    { payload: Uint8Array; children: readonly PageId[] }
  >();

  constructor(
    private readonly store: KeyValueStore,
    public nextId: number,
  ) {}

  async readPage(id: PageId): Promise<Uint8Array> {
    const pending = this.pending.get(id);
    if (pending) return Uint8Array.from(pending.payload);
    const value = await this.store.get(pageKey(id));
    if (value === undefined) throw new Error(`Missing page ${id}`);
    return value; // Backend reads already belong to the caller.
  }

  writePage(
    payload: Uint8Array,
    children: readonly PageId[] = [],
  ): Promise<PageId> {
    return this.writePageOwned(Uint8Array.from(payload), children);
  }

  async writePageOwned(
    payload: Uint8Array,
    children: readonly PageId[],
  ): Promise<PageId> {
    if (!Number.isSafeInteger(this.nextId + 1))
      throw new RangeError("Page IDs exhausted");
    const id = this.nextId++;
    this.pending.set(id, { payload, children: [...children] });
    return id;
  }

  /** Called after each row mutation, while all current table/index roots are
   * known. Published pages cannot reference newer staged IDs, so tracing stops
   * at the backing store without reading or decoding any page payloads. */
  retainRoots(roots: readonly (PageId | null)[]): void {
    const live = new Set<PageId>();
    const stack = [...roots];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === null || live.has(id)) continue;
      const page = this.pending.get(id);
      if (!page) continue;
      live.add(id);
      stack.push(...page.children);
    }
    for (const id of this.pending.keys())
      if (!live.has(id)) this.pending.delete(id);
  }

  operations(): KeyValueOperation[] {
    return [...this.pending].flatMap(([id, { payload }]) => {
      const key = pageKey(id);
      const size = new Uint8Array(8);
      new DataView(size.buffer).setFloat64(0, payload.byteLength);
      return [
        { type: "put" as const, key, value: payload },
        { type: "put" as const, key: pageSizeKey(key), value: size },
      ];
    });
  }

  discard(): void {
    this.pending.clear();
    // Cache entries may still name aborted IDs. Never reuse them in this process.
  }
}
