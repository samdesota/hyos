import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { MemoryLimitExceededError, MemoryManager } from "../src/memory.js";
import { ByteLruCache } from "../src/node/index.js";
import {
  hydb,
  id,
  memoryStorage,
  storageMutation,
  text,
} from "../src/index.js";

test("memory pressure reclaims lower-priority unpinned allocations first", () => {
  const memory = new MemoryManager({ maxBytes: 10 });
  let cacheBytes = 6;
  const cache = memory.track({
    owner: "page-cache",
    bytes: cacheBytes,
    priority: 0,
    reclaim: (target) => {
      const reclaimed = Math.min(target, cacheBytes);
      cacheBytes -= reclaimed;
      return reclaimed;
    },
  });
  const pinned = memory.track({
    owner: "subscriptions",
    bytes: 4,
    priority: 10,
  });

  pinned.resize(8);

  assert.equal(cacheBytes, 2);
  assert.equal(cache.bytes, 2);
  assert.deepEqual(memory.stats(), {
    maxBytes: 10,
    usedBytes: 10,
    availableBytes: 0,
    overBudgetBytes: 0,
    allocations: 2,
    evictions: 1,
    reclaimedBytes: 4,
    byOwner: { "page-cache": 2, subscriptions: 8 },
  });
});

test("strict reservations fail without leaking memory and succeed after release", () => {
  const memory = new MemoryManager({ maxBytes: 8 });
  const state = memory.track({ owner: "dataflow", bytes: 6 });

  assert.throws(
    () => memory.reserve({ owner: "executor", bytes: 3 }),
    MemoryLimitExceededError,
  );
  assert.equal(memory.stats().usedBytes, 6);

  state.release();
  const reservation = memory.reserve({ owner: "executor", bytes: 8 });
  assert.equal(memory.stats().usedBytes, 8);
  reservation.release();
  assert.equal(memory.stats().usedBytes, 0);
});

test("a host can lower the budget or proactively reclaim cache memory", () => {
  const memory = new MemoryManager({ maxBytes: 10 });
  let cacheBytes = 6;
  memory.track({
    owner: "cache",
    bytes: cacheBytes,
    reclaim: (target) => {
      const reclaimed = Math.min(target, cacheBytes);
      cacheBytes -= reclaimed;
      return reclaimed;
    },
  });
  memory.track({ owner: "live-state", bytes: 4 });

  memory.setMaxBytes(5);
  assert.equal(cacheBytes, 1);
  assert.equal(memory.stats().maxBytes, 5);
  assert.equal(memory.reclaim(1), 1);
  assert.equal(memory.stats().usedBytes, 4);
  assert.throws(() => memory.setMaxBytes(-1), /non-negative safe integer/);
});

test("the byte cache participates in a shared memory budget", async () => {
  const memory = new MemoryManager({ maxBytes: 6 });
  const cache = new ByteLruCache(
    100,
    async (key: string) => key.repeat(3),
    (value) => value.length,
    { memory, owner: "tree-pages" },
  );

  await cache.get("a");
  await cache.get("b");
  const queryState = memory.track({ owner: "query", bytes: 3 });

  assert.equal(cache.stats().residentBytes, 3);
  assert.equal(memory.stats().usedBytes, 6);
  assert.deepEqual(memory.stats().byOwner, {
    query: 3,
    "tree-pages": 3,
  });

  queryState.release();
  cache.dispose();
  assert.equal(memory.stats().usedBytes, 0);
});

test("database query memory is released after fetch and subscription disposal", async () => {
  const items = hydb.table("items", {
    id: id().primaryKey(),
    title: text().notNull(),
  });
  const schema = hydb.schema({ items });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(items, { id: "item-1", title: "Remember me" }),
    ],
  });
  const memory = new MemoryManager({ maxBytes: 1024 * 1024 });
  const db = await hydb.database({ schema, storage, memory });
  const query = hydb
    .query(items)
    .select((item) => ({ id: item.id, title: item.title }))
    .many();

  assert.deepEqual(await db.fetch(query), [
    { id: "item-1", title: "Remember me" },
  ]);
  assert.equal(db.memoryStats().usedBytes, 0);

  let resolveInitial!: () => void;
  const initialResult = new Promise<void>((resolve) => {
    resolveInitial = resolve;
  });
  const unsubscribe = db.subscribe(query, () => resolveInitial());
  await initialResult;
  assert.ok(db.memoryStats().usedBytes > 0);
  assert.ok((db.memoryStats().byOwner.subscriptions ?? 0) > 0);
  assert.ok((db.memoryStats().byOwner.dataflow ?? 0) > 0);

  const beforeInsert = db.memoryStats().usedBytes;
  let transactionBytes = 0;
  const addItem = hydb.command({
    input: z.object({ id: z.string(), title: z.string() }),
    handler: async (transaction, input) => {
      await transaction.insert(items, input);
      transactionBytes = memory.stats().byOwner.transactions ?? 0;
    },
  });
  await db.execute(addItem, { id: "item-2", title: "Account for me" });
  assert.ok(transactionBytes > 0);
  assert.ok(db.memoryStats().usedBytes > beforeInsert);
  assert.equal(db.memoryStats().byOwner.transactions, undefined);

  unsubscribe();
  assert.equal(db.memoryStats().usedBytes, 0);
  await db.close();
});
