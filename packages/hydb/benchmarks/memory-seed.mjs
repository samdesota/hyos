import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydb, id, index, text, storageMutation } from "../dist/src/index.js";
import {
  openKeyValueStorage,
  openLmdbKeyValueStore,
} from "../dist/src/node/index.js";
import { createMemoryProfile } from "./memory-profile.mjs";

const batchRows = Number(process.argv[2] ?? 64);
const output = process.argv[3];
assert.ok(output && Number.isSafeInteger(batchRows) && batchRows > 0);
const profile = await createMemoryProfile(output);
const directory = await mkdtemp(join(tmpdir(), "hydb-memory-seed-"));
const rows = hydb.table(
  "items",
  {
    id: id().primaryKey(),
    bucket: text().notNull(),
    payload: text().notNull(),
  },
  (c) => [index("by_bucket").on(c.bucket)],
);
const backend = openLmdbKeyValueStore(directory);
const batches = [];
let storage;
try {
  storage = await openKeyValueStorage({
    schema: hydb.schema({ rows }),
    cacheBytes: 16 * 1024 * 1024,
    maxEntries: 64,
    store: {
      ...backend,
      async batch(operations, conditions) {
        const before = process.memoryUsage();
        const payloadBytes = operations.reduce(
          (total, op) => total + (op.type === "put" ? op.value.byteLength : 0),
          0,
        );
        const pending = backend.batch(operations, conditions);
        const prepared = process.memoryUsage();
        profile.sample(prepared);
        await pending;
        batches.push({
          operations: operations.length,
          payloadBytes,
          before,
          prepared,
          after: process.memoryUsage(),
        });
      },
    },
  });
  await profile.checkpoint("opened");
  profile.phase("seed");
  const sample = setInterval(() => profile.sample(), 5);
  try {
    for (let offset = 0; offset < 256; offset += batchRows) {
      await storage.commit({
        expectedHead: await storage.head(),
        mutations: Array.from(
          { length: Math.min(batchRows, 256 - offset) },
          (_, j) => {
            const i = offset + j;
            return storageMutation.insert(rows, {
              id: String(i).padStart(8, "0"),
              bucket: String(i % 16),
              payload: String(i).padStart(16384, "x"),
            });
          },
        ),
      });
      profile.sample();
    }
  } finally {
    clearInterval(sample);
  }
  await profile.checkpoint("seedComplete");
  await profile.collectJsGarbage("seedJsGc");
  const snapshot = await storage.snapshot();
  let count = 0;
  for await (const batch of snapshot.scan({ type: "table", table: rows }))
    for (const row of batch) {
      assert.equal(row.payload.length, 16384);
      count++;
    }
  assert.equal(count, 256);
  await snapshot.close();
  await storage.close();
  storage = undefined;
  await profile.collectJsGarbage("closedJsGc");
  await writeFile(
    join(output, "batches.json"),
    JSON.stringify(
      { batchRows, livePayloadBytes: 256 * 16384, batches },
      null,
      2,
    ) + "\n",
  );
} finally {
  await storage?.close();
  await backend.close();
  await rm(directory, { recursive: true, force: true });
}
