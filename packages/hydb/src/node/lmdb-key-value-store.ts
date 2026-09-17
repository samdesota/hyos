import { open } from "lmdb";
import {
  checkValue,
  keyBytes,
  prepareBatch,
  scanBounds,
  type KeyValueStore,
} from "./key-value-store.js";

// lmdb's safe binary get/getMany/getRange return owned buffers (never use
// getBinaryFast/getSharedBinary here). A view preserves that ownership without
// a second payload copy, including when the buffer has a nonzero byte offset.
const ownedBytes = (value: Uint8Array): Uint8Array =>
  new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

/** Native LMDB adapter. All publication batches await durable flushing. */
export function openLmdbKeyValueStore(directory: string): KeyValueStore {
  const db = open<Buffer, Buffer>({
    path: directory,
    encoding: "binary",
    keyEncoding: "binary",
    // Use the binding's portable conservative sync mode for the prototype.
    overlappingSync: false,
    noSync: false,
    noMetaSync: false,
  });
  let closed = false;
  let failed = false;
  let writes: Promise<void> = Promise.resolve();
  const assertOpen = () => {
    if (closed || failed)
      throw new Error(
        "Key-value store is closed or requires reopening after a flush failure",
      );
  };
  return {
    async get(key) {
      assertOpen();
      const value = db.get(keyBytes(key));
      return value === undefined ? undefined : ownedBytes(value);
    },
    async getMany(keys) {
      assertOpen();
      const values = await db.getMany(keys.map((key) => keyBytes(key)));
      return values.map((value) =>
        value === undefined ? undefined : ownedBytes(value),
      );
    },
    async *scan(prefix = "", options = {}) {
      assertOpen();
      const bounds = scanBounds(prefix, options);
      const start = bounds.start;
      let count = 0;
      for (const { key, value } of db.getRange({ start, snapshot: true })) {
        if (!key.subarray(0, bounds.prefix.length).equals(bounds.prefix)) break;
        if (bounds.after && Buffer.compare(key, bounds.after) <= 0) continue;
        assertOpen();
        yield { key: key.toString("utf8"), value: ownedBytes(value) };
        if (++count >= bounds.limit) break;
      }
    },
    async *scanKeys(prefix = "", options = {}) {
      assertOpen();
      const bounds = scanBounds(prefix, options);
      let count = 0;
      for (const key of db.getKeys({ start: bounds.start, snapshot: true })) {
        if (!key.subarray(0, bounds.prefix.length).equals(bounds.prefix)) break;
        if (bounds.after && Buffer.compare(key, bounds.after) <= 0) continue;
        assertOpen();
        yield key.toString("utf8");
        if (++count >= bounds.limit) break;
      }
    },
    async batch(operations, conditions = []) {
      assertOpen();
      const prepared = prepareBatch(operations, conditions);
      const result = writes.then(async () => {
        if (failed)
          throw new Error(
            "Key-value store requires reopening after a flush failure",
          );
        // The callback must stay synchronous. A child transaction ensures an
        // exception rolls back this batch without affecting other queued work.
        await db.childTransaction(() => {
          for (const condition of prepared.conditions)
            checkValue(condition, db.get(keyBytes(condition.key)));
          for (const op of prepared.operations) {
            if (op.type === "put")
              db.putSync(
                keyBytes(op.key),
                Buffer.from(
                  op.value.buffer,
                  op.value.byteOffset,
                  op.value.byteLength,
                ),
              );
            else db.removeSync(keyBytes(op.key));
          }
        });
        try {
          await db.flushed;
        } catch (error) {
          failed = true;
          throw error;
        }
      });
      writes = result.catch(() => undefined);
      await result;
    },
    async close() {
      if (closed) return;
      closed = true;
      await writes;
      await db.close();
    },
  };
}
