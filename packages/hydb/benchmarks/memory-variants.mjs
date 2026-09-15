// Diagnostic only: substitutes keys-only enumeration in the collector's page
// sweep. Dummy values deliberately make GC byte accounting invalid. This is not
// a general KeyValueStore implementation and must never be used by the app.
import { open } from "lmdb";
import { openLmdbKeyValueStore } from "../dist/src/node/index.js";

export function keysOnlySweepStore(directory) {
  const backend = openLmdbKeyValueStore(directory);
  const cursorDb = open({
    path: directory,
    encoding: "binary",
    keyEncoding: "binary",
    overlappingSync: false,
    noSync: false,
    noMetaSync: false,
  });
  return {
    ...backend,
    async *scan(prefix = "", options = {}) {
      if (prefix !== "page/") {
        yield* backend.scan(prefix, options);
        return;
      }
      const start = Buffer.from(options.after ?? prefix);
      let count = 0;
      for (const key of cursorDb.getKeys({ start, snapshot: true })) {
        const name = key.toString("utf8");
        if (!name.startsWith(prefix)) break;
        if (
          options.after &&
          Buffer.compare(key, Buffer.from(options.after)) <= 0
        )
          continue;
        yield { key: name, value: new Uint8Array() };
        if (++count >= (options.limit ?? Infinity)) break;
      }
    },
    async close() {
      await cursorDb.close();
      await backend.close();
    },
  };
}
