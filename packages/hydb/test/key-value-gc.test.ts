import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hydb,
  id,
  index,
  text,
  storageMutation,
  HistoryUnavailableError,
} from "../src/index.js";
import {
  memoryKeyValueStore,
  openKeyValueStorage,
  openLmdbKeyValueStore,
  type KeyValueStore,
  type KeyValueStorageDatabase,
} from "../src/node/index.js";

const rows = hydb.table(
  "rows",
  { id: id().primaryKey(), value: text().notNull() },
  (c) => [index("value_idx").on(c.value)],
);
const schema = hydb.schema({ rows });
const retention = { mode: "window", keepAtLeast: 1 } as const;
const options = {
  schema,
  retention,
  maxEntries: 4,
  cacheBytes: 0,
  gcBatchSize: 2,
};
const row = (value: string) => ({ id: "one", value });
async function write(
  db: KeyValueStorageDatabase,
  value: string,
  first = false,
) {
  return db.commit({
    expectedHead: await db.head(),
    mutations: [
      first
        ? storageMutation.insert(rows, row(value))
        : storageMutation.update(rows, ["one"], row(value)),
    ],
  });
}
async function count(store: KeyValueStore, prefix: string) {
  let total = 0;
  for await (const _ of store.scan(prefix)) total++;
  return total;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const backend of ["memory", "lmdb"] as const) {
  test(`${backend}: bounded reclamation preserves roots, readers, indexes and recent history`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydb-gc-roots-"));
    const store =
      backend === "memory"
        ? memoryKeyValueStore()
        : openLmdbKeyValueStore(directory);
    let deletions = 0;
    const tracked: KeyValueStore = {
      ...store,
      async batch(operations, conditions) {
        if (operations.some((op) => op.type === "delete")) {
          deletions++;
          assert.ok(
            operations.length <= 3 * options.gcBatchSize + 1,
            "bounded transaction size",
          );
        }
        await store.batch(operations, conditions);
      },
    };
    let db = await openKeyValueStorage({ ...options, store: tracked });
    try {
      const first = await write(db, "base", true);
      await db.createBranch({ name: "feature", from: first.commit });
      const retained = await write(db, "named");
      await db.retain({ name: "saved", commit: retained.commit });
      const pinned = await write(db, "pinned");
      const reader = await db.snapshot();
      const expired = await write(db, "expired");
      const latest = await write(db, "latest");
      const before = await count(store, "page/");
      const report = await db.collectGarbage();
      assert.ok(report.pagesCollected > 0);
      assert.equal(report.commitsCollected, 1);
      assert.equal(report.recordsCopied, 0);
      assert.equal(
        report.bytesBefore - report.bytesAfter,
        report.bytesReclaimed,
      );
      assert.ok(report.bytesReclaimed > 0);
      assert.equal(await count(store, "page/"), before - report.pagesCollected);
      assert.ok(deletions > 1);
      assert.deepEqual(await reader.get(rows, ["one"]), row("pinned"));
      await assert.rejects(
        db.snapshot({ commit: expired.commit }),
        HistoryUnavailableError,
      );
      for (const [commit, value] of [
        [first.commit, "base"],
        [retained.commit, "named"],
        [pinned.commit, "pinned"],
        [latest.commit, "latest"],
      ]) {
        const snapshot = await db.snapshot({ commit: commit! });
        assert.deepEqual(await snapshot.get(rows, ["one"]), row(value!));
        const found = [];
        for await (const batch of snapshot.scan({
          type: "index",
          table: rows,
          index: "value_idx",
          key: [value!],
        }))
          found.push(...batch);
        assert.deepEqual(found, [row(value!)]);
        await snapshot.close();
      }
      const stale = db.changes({ after: 0 })[Symbol.asyncIterator]();
      await assert.rejects(
        stale.next(),
        (error: unknown) =>
          error instanceof HistoryUnavailableError &&
          error.oldestAvailableSequence === 4,
      );
      await reader.close();
      await db.releaseRetention("saved");
      const second = await db.collectGarbage();
      assert.equal(second.commitsCollected, 2);
      assert.equal((await db.collectGarbage()).pagesCollected, 0);
      if (backend === "lmdb") {
        await db.close();
        db = await openKeyValueStorage({ ...options, directory });
        assert.equal(await db.head(), latest.commit);
        await assert.rejects(
          db.snapshot({ commit: pinned.commit }),
          HistoryUnavailableError,
        );
        const oldChanges = db.changes({ after: 0 })[Symbol.asyncIterator]();
        await assert.rejects(oldChanges.next(), HistoryUnavailableError);
        const feature = await db.snapshot({ branch: "feature" });
        assert.deepEqual(await feature.get(rows, ["one"]), row("base"));
        await feature.close();
      }
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("changes replay pins unread history and releases it when the consumer aborts", async () => {
  const db = await openKeyValueStorage({
    ...options,
    store: memoryKeyValueStore(),
  });
  try {
    await write(db, "1", true);
    const two = await write(db, "2");
    const three = await write(db, "3");
    const controller = new AbortController();
    const stream = db
      .changes({ after: 0, signal: controller.signal })
      [Symbol.asyncIterator]();
    assert.equal((await stream.next()).value?.sequence, 1);
    await db.collectGarbage();
    assert.equal((await stream.next()).value?.commit, two.commit);
    const four = await write(db, "4");
    await db.collectGarbage();
    assert.equal((await stream.next()).value?.commit, three.commit);
    assert.equal((await stream.next()).value?.commit, four.commit);
    controller.abort();
    await stream.return?.();
    assert.ok((await db.collectGarbage()).commitsCollected > 0);
  } finally {
    await db.close();
  }
});

for (const phase of ["mark", "sweep"])
  test(`commits and new readers complete during ${phase}; shared pages survive`, async () => {
    const backend = memoryKeyValueStore();
    const paused = gate(),
      resume = gate();
    let collecting = false,
      commitScans = 0;
    const store: KeyValueStore = {
      ...backend,
      async *scan(prefix, range) {
        // End of pruning/start of marking: replay from the beginning of commit keys.
        if (
          collecting &&
          range?.after === undefined &&
          ((phase === "mark" && prefix === "commit/" && ++commitScans === 2) ||
            (phase === "sweep" && prefix === "page/"))
        ) {
          paused.release();
          await resume.promise;
        }
        yield* backend.scan(prefix, range);
      },
    };
    const db = await openKeyValueStorage({ ...options, store });
    try {
      await db.commit({
        expectedHead: await db.head(),
        mutations: Array.from({ length: 40 }, (_, i) =>
          storageMutation.insert(rows, {
            id: `shared-${i}`,
            value: `unchanged-${i}`,
          }),
        ),
      });
      await write(db, "1", true);
      await write(db, "2");
      const head = await write(db, "3");
      collecting = true;
      const gc = db.collectGarbage();
      assert.equal(db.collectGarbage(), gc, "collectors coalesce");
      await paused.promise;
      const snapshot = await db.snapshot({ commit: head.commit });
      const latest = await write(db, "concurrent");
      await db.createBranch({ name: "during-gc", from: head.commit });
      await db.retain({ name: "during-gc", commit: head.commit });
      assert.deepEqual(await snapshot.get(rows, ["one"]), row("3"));
      resume.release();
      await gc;
      const current = await db.snapshot();
      assert.equal(current.commit, latest.commit);
      assert.deepEqual(await current.get(rows, ["one"]), row("concurrent"));
      for (let i = 0; i < 40; i++)
        assert.deepEqual(await current.get(rows, [`shared-${i}`]), {
          id: `shared-${i}`,
          value: `unchanged-${i}`,
        });
      await current.close();
      await snapshot.close();
      await db.collectGarbage();
      const branch = await db.snapshot({ branch: "during-gc" });
      assert.deepEqual(await branch.get(rows, ["one"]), row("3"));
      await branch.close();
    } finally {
      resume.release();
      await db.close();
    }
  });

test("snapshot and change admission cannot race a selected deletion", async () => {
  const backend = memoryKeyValueStore();
  const paused = gate(),
    resume = gate();
  let collecting = false,
    selected = "";
  const store: KeyValueStore = {
    ...backend,
    async batch(ops, conditions) {
      const removed = ops.find(
        (op) => op.type === "delete" && op.key.startsWith("commit/"),
      );
      if (collecting && removed) {
        selected = removed.key.slice(7);
        paused.release();
        await resume.promise;
      }
      await backend.batch(ops, conditions);
    },
  };
  const db = await openKeyValueStorage({ ...options, store });
  try {
    await write(db, "1", true);
    await write(db, "2");
    await write(db, "3");
    collecting = true;
    const gc = db.collectGarbage();
    await paused.promise;
    await assert.rejects(
      db.snapshot({ commit: selected }),
      HistoryUnavailableError,
    );
    const stream = db.changes({ after: 0 })[Symbol.asyncIterator]();
    await assert.rejects(stream.next(), HistoryUnavailableError);
    const latest = await db.snapshot();
    assert.deepEqual(await latest.get(rows, ["one"]), row("3"));
    await latest.close();
    resume.release();
    await gc;
  } finally {
    resume.release();
    await db.close();
  }
});

for (const phase of ["commit/", "page/"]) {
  test(`interrupted ${phase} deletion restarts safely after reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydb-gc-restart-"));
    const backend = openLmdbKeyValueStore(directory);
    let fail = false;
    const store: KeyValueStore = {
      ...backend,
      async batch(ops, conditions) {
        await backend.batch(ops, conditions);
        if (
          fail &&
          ops.some((op) => op.type === "delete" && op.key.startsWith(phase))
        )
          throw new Error("interrupted cleanup after durable batch");
      },
    };
    let db = await openKeyValueStorage({ ...options, store });
    try {
      await write(db, "1", true);
      await write(db, "2");
      const last = await write(db, "3");
      fail = true;
      await assert.rejects(db.collectGarbage(), /interrupted cleanup/);
      await db.close();
      db = await openKeyValueStorage({ ...options, directory });
      assert.equal(await db.head(), last.commit);
      await db.collectGarbage();
      const snapshot = await db.snapshot();
      assert.deepEqual(await snapshot.get(rows, ["one"]), row("3"));
      await snapshot.close();
      await write(db, "after-restart");
      await db.collectGarbage();
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("forever and age/count policies keep history while removing intermediate pages", async () => {
  for (const policy of [
    { mode: "forever" } as const,
    { mode: "window", keepAtLeast: 1, keepYoungerThanMs: 60_000 } as const,
    { mode: "window", keepAtLeast: 5 } as const,
  ]) {
    const db = await openKeyValueStorage({
      ...options,
      retention: policy,
      store: memoryKeyValueStore(),
    });
    try {
      const commit = await db.commit({
        expectedHead: await db.head(),
        mutations: [
          storageMutation.insert(rows, row("1")),
          storageMutation.update(rows, ["one"], row("2")),
        ],
      });
      await write(db, "3");
      const report = await db.collectGarbage();
      assert.equal(report.commitsCollected, 0);
      assert.ok(report.pagesCollected > 0);
      const snapshot = await db.snapshot({ commit: commit.commit });
      assert.deepEqual(await snapshot.get(rows, ["one"]), row("2"));
      await snapshot.close();
    } finally {
      await db.close();
    }
  }
});

test("closing cancels collection at a slice boundary and drains accepted commits", async () => {
  const backend = memoryKeyValueStore();
  const paused = gate(),
    resume = gate();
  let pause = false;
  const store: KeyValueStore = {
    ...backend,
    async *scan(prefix, range) {
      if (pause && prefix === "commit/") {
        paused.release();
        await resume.promise;
      }
      yield* backend.scan(prefix, range);
    },
  };
  const db = await openKeyValueStorage({ ...options, store });
  await write(db, "1", true);
  await write(db, "2");
  pause = true;
  const gc = db.collectGarbage();
  const rejected = assert.rejects(gc, /closed/);
  await paused.promise;
  // Admit a write before close; collection must not keep shutdown waiting for
  // another full pass, and must not close the backend underneath this write.
  const accepted = db.commit({
    expectedHead: await db.head(),
    mutations: [storageMutation.update(rows, ["one"], row("3"))],
  });
  const closing = db.close();
  resume.release();
  await accepted;
  await rejected;
  await closing;
});

test("a snapshot admitted during pruning is included in the next root check", async () => {
  const backend = memoryKeyValueStore();
  const paused = gate(),
    resume = gate();
  let collecting = false,
    selected = "";
  const store: KeyValueStore = {
    ...backend,
    async *scan(prefix, range) {
      yield* backend.scan(prefix, range);
      if (collecting && prefix === "commit/" && !range?.after) {
        paused.release();
        await resume.promise;
      }
    },
  };
  const db = await openKeyValueStorage({ ...options, store, gcBatchSize: 16 });
  try {
    selected = (await write(db, "1", true)).commit;
    await write(db, "2");
    await write(db, "3");
    collecting = true;
    const gc = db.collectGarbage();
    await paused.promise;
    const reader = await db.snapshot({ commit: selected });
    resume.release();
    await gc;
    assert.deepEqual(await reader.get(rows, ["one"]), row("1"));
    await reader.close();
    await db.collectGarbage();
    await assert.rejects(
      db.snapshot({ commit: selected }),
      HistoryUnavailableError,
    );
  } finally {
    resume.release();
    await db.close();
  }
});
