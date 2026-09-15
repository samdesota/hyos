import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { hydb, id, text } from "../src/index.js";
import { openKeyValueStorage } from "../src/node/index.js";

// Also runnable under ELECTRON_RUN_AS_NODE=1 to exercise Electron's native
// module loading and the same CJS entrypoint that the app uses.
for (const interruptGc of [false, true])
  test(`CJS native runtime: process exit ${interruptGc ? "during GC" : "after commit"} survives without close`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydb-kv-runtime-"));
    const publicPath = fileURLToPath(
      new URL("../../dist-cjs/src/index.js", import.meta.url),
    );
    const nodePath = fileURLToPath(
      new URL("../../dist-cjs/src/node/index.js", import.meta.url),
    );
    try {
      const script = `
      const { hydb, id, text, storageMutation } = require(${JSON.stringify(publicPath)});
      const { openKeyValueStorage, openLmdbKeyValueStore } = require(${JSON.stringify(nodePath)});
      (async () => {
        const items = hydb.table("items", { id: id().primaryKey(), value: text().notNull() });
        const backend = openLmdbKeyValueStore(process.argv[1]);
        const store = { ...backend, async batch(ops, conditions) {
          await backend.batch(ops, conditions);
          if (${interruptGc} && ops.some(op => op.type === "delete" && op.key.startsWith("page/"))) process.exit(0);
        } };
        const storage = await openKeyValueStorage({ schema: hydb.schema({ items }), store, retention: { mode: "window", keepAtLeast: 1 }, gcBatchSize: 1 });
        await storage.commit({ expectedHead: await storage.head(), mutations: [storageMutation.insert(items, { id: "one", value: "durable" })] });
        if (${interruptGc}) {
          for (let i = 0; i < 2; i++) await storage.commit({ expectedHead: await storage.head(), mutations: [storageMutation.update(items, ["one"], { id: "one", value: "durable" })] });
          await storage.collectGarbage();
          throw new Error("Expected process exit inside GC page deletion");
        }
        // No normal cleanup: durability must follow from commit acknowledgement.
        process.exit(0);
      })().catch(error => { console.error(error); process.exit(1); });
    `;
      await promisify(execFile)(process.execPath, ["-e", script, directory], {
        timeout: 15_000,
      });
      const items = hydb.table("items", {
        id: id().primaryKey(),
        value: text().notNull(),
      });
      const storage = await openKeyValueStorage({
        schema: hydb.schema({ items }),
        directory,
      });
      try {
        if (interruptGc) await storage.collectGarbage();
        const snapshot = await storage.snapshot();
        assert.deepEqual(await snapshot.get(items, ["one"]), {
          id: "one",
          value: "durable",
        });
        await snapshot.close();
      } finally {
        await storage.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
