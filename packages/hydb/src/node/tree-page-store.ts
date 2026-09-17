/**
 * An opaque, store-local page identity. Numeric IDs preserve the existing disk
 * format; consumers must not interpret them as offsets or assume ordering.
 */
export type PageId = number;

/**
 * Immutable page storage used by the B+ tree.
 *
 * A successful write allocates a fresh ID and makes the bytes readable by this
 * store. Stored bytes must not change when the caller reuses its input buffer;
 * read buffers belong to the caller. Missing pages reject rather than returning
 * empty data. IDs must not be recycled while any root can still reference them.
 *
 * Writes are serialized by the owner; reads may overlap. This interface does
 * not promise durability or atomic root publication: the storage engine owns
 * transaction commit, syncing, page lifetime, and closing the backing store.
 */
export interface TreePageStore {
  readPage(id: PageId): Promise<Uint8Array>;
  /** children lists every referenced page; omit only for a leaf payload. */
  writePage(payload: Uint8Array, children?: readonly PageId[]): Promise<PageId>;
  /** Optional ownership transfer: caller must never reuse/mutate payload after
   * calling. children describes references in the immutable payload. */
  writePageOwned?(
    payload: Uint8Array,
    children: readonly PageId[],
  ): Promise<PageId>;
}
