import type { KeyValueOperation, KeyValueStore } from "./key-value-store.js";
import type { PageId, TreePageStore } from "./tree-page-store.js";

export const pageKey = (id: PageId): string =>
  `page/${id.toString().padStart(16, "0")}`;

/** Pages created by a single writer stay private until its publication batch. */
export class KeyValuePages implements TreePageStore {
  private readonly pending = new Map<PageId, Uint8Array>();

  constructor(
    private readonly store: KeyValueStore,
    public nextId: number,
  ) {}

  async readPage(id: PageId): Promise<Uint8Array> {
    const value = this.pending.get(id) ?? (await this.store.get(pageKey(id)));
    if (value === undefined) throw new Error(`Missing page ${id}`);
    return Uint8Array.from(value);
  }

  async writePage(payload: Uint8Array): Promise<PageId> {
    if (!Number.isSafeInteger(this.nextId + 1))
      throw new RangeError("Page IDs exhausted");
    const id = this.nextId++;
    this.pending.set(id, Uint8Array.from(payload));
    return id;
  }

  operations(): KeyValueOperation[] {
    return [...this.pending].map(([id, value]) => ({
      type: "put",
      key: pageKey(id),
      value,
    }));
  }

  discard(): void {
    this.pending.clear();
    // Do not rewind IDs after a failed transaction: the tree cache may still
    // contain decoded unpublished pages. A new process has an empty cache.
  }
}
