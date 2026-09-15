import {
  checkValue,
  keyBytes,
  prepareBatch,
  scanBounds,
  type KeyValueStore,
} from "./key-value-store.js";

/** In-memory adapter for the same binary contract as the persistent backend. */
export function memoryKeyValueStore(): KeyValueStore {
  const values = new Map<string, Uint8Array>();
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Key-value store is closed");
  };
  return {
    async get(key) {
      assertOpen();
      keyBytes(key);
      return values.get(key)?.slice();
    },
    async getMany(keys) {
      assertOpen();
      keys.forEach((key) => keyBytes(key));
      return keys.map((key) => values.get(key)?.slice());
    },
    async *scan(prefix = "", options = {}) {
      assertOpen();
      const bounds = scanBounds(prefix, options);
      // Batch replaces values rather than mutating them, so these references
      // describe a stable snapshot without copying the entire value payloads.
      const snapshot = [...values]
        .filter(
          ([key]) =>
            key.startsWith(prefix) &&
            (!bounds.after ||
              Buffer.compare(Buffer.from(key), bounds.after) > 0),
        )
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .slice(0, bounds.limit);
      for (const [key, value] of snapshot) {
        assertOpen();
        yield { key, value: value.slice() };
      }
    },
    async batch(operations, conditions = []) {
      assertOpen();
      const prepared = prepareBatch(operations, conditions);
      for (const condition of prepared.conditions)
        checkValue(condition, values.get(condition.key));
      // No await between validation and application: readers cannot observe a
      // partially applied batch in this single-threaded adapter.
      for (const op of prepared.operations) {
        if (op.type === "put") values.set(op.key, op.value);
        else values.delete(op.key);
      }
    },
    async close() {
      closed = true;
      values.clear();
    },
  };
}
