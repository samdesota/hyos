import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hydb,
  id,
  index,
  storageMutation,
  text,
  uniqueIndex,
  type StorageDatabase,
} from "../src/index.js";
import {
  KeyValueConflictError,
  memoryKeyValueStore,
  openKeyValueStorage,
  openLmdbKeyValueStore,
  openNodeStorage,
  type KeyValueStore,
} from "../src/node/index.js";

const rows = hydb.table(
  "rows",
  { id: id().primaryKey(), group: text().notNull(), title: text().notNull() },
  (columns) => [
    index("by_group").on(columns.group),
    uniqueIndex("by_title").on(columns.title),
  ],
);
const schema = hydb.schema({ rows });
const row = (i: number) => ({
  id: String(i).padStart(3, "0"),
  group: `g${i % 3}`,
  title: `Row ${i}`,
});
const insert = (i: number) => storageMutation.insert(rows, row(i));
async function commit(
  storage: StorageDatabase,
  mutations: Parameters<StorageDatabase["commit"]>[0]["mutations"],
  branch = "main",
) {
  return storage.commit({
    branch,
    expectedHead: await storage.head(branch),
    mutations,
  });
}

for (const backend of ["file", "memory-kv", "lmdb"] as const) {
  test(`${backend}: tree storage parity, rollback, branches, history and query runtime`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydb-kv-parity-"));
    const options = { schema, maxEntries: 4, cacheBytes: 128 };
    let storage: StorageDatabase =
      backend === "file"
        ? await openNodeStorage({ directory, ...options })
        : await openKeyValueStorage(
            backend === "lmdb"
              ? { directory, ...options }
              : { store: memoryKeyValueStore(), ...options },
          );
    try {
      const initial = await storage.head();
      const first = await commit(
        storage,
        Array.from({ length: 40 }, (_, i) => insert(i)),
      );
      const old = await storage.snapshot();
      await storage.createBranch({ name: "feature/a", from: first.commit });
      await assert.rejects(
        commit(storage, [
          insert(50),
          storageMutation.insert(rows, { ...row(51), title: "Row 1" }),
        ]),
        /Unique index/,
      );
      assert.equal(await storage.head(), first.commit);
      const afterFailure = await storage.snapshot();
      assert.equal(await afterFailure.get(rows, ["050"]), undefined);
      await afterFailure.close();
      const second = await commit(storage, [
        storageMutation.update(rows, ["000"], {
          ...row(0),
          group: "other",
          title: "Updated",
        }),
        storageMutation.delete(rows, ["001"]),
        insert(50),
      ]);
      const feature = await commit(
        storage,
        [storageMutation.delete(rows, ["002"])],
        "feature/a",
      );
      assert.deepEqual(await old.get(rows, ["000"]), row(0));
      assert.deepEqual(await old.get(rows, ["001"]), row(1));
      await old.close();
      await storage.retain({ name: "backup/a", commit: first.commit });
      if (backend !== "memory-kv") {
        await storage.close();
        storage =
          backend === "file"
            ? await openNodeStorage({ directory, ...options })
            : await openKeyValueStorage({ directory, ...options });
      }
      assert.equal(await storage.head(), second.commit);
      assert.equal(await storage.head("feature/a"), feature.commit);
      const snapshot = await storage.snapshot();
      assert.deepEqual(await snapshot.get(rows, ["050"]), row(50));
      assert.equal(await snapshot.get(rows, ["001"]), undefined);
      const ranged = (
        await collect(
          snapshot.scan({
            type: "table",
            table: rows,
            range: { gte: ["010"], lt: ["020"], reverse: true, limit: 3 },
          }),
        )
      ).flat();
      assert.deepEqual(
        ranged.map((value) => value.id),
        ["019", "018", "017"],
      );
      const indexed = (
        await collect(
          snapshot.scan({
            type: "index",
            table: rows,
            index: "by_group",
            key: ["other"],
          }),
        )
      ).flat();
      assert.deepEqual(
        indexed.map((value) => value.title),
        ["Updated"],
      );
      await snapshot.close();
      const historical = await storage.snapshot({ commit: initial });
      assert.equal(await historical.get(rows, ["000"]), undefined);
      await historical.close();
      const branchSnapshot = await storage.snapshot({ branch: "feature/a" });
      assert.equal(branchSnapshot.sequence, 1);
      assert.equal(await branchSnapshot.get(rows, ["002"]), undefined);
      assert.deepEqual(await branchSnapshot.get(rows, ["000"]), row(0));
      await branchSnapshot.close();
      await assert.rejects(
        storage.retain({ name: "backup/a", commit: second.commit }),
        /Retention already exists/,
      );
      await storage.releaseRetention("backup/a");
      const controller = new AbortController();
      const changes = storage
        .changes({ after: 0, signal: controller.signal })
        [Symbol.asyncIterator]();
      assert.equal((await changes.next()).value?.commit, first.commit);
      // A commit during replay must be delivered once, after the replay bound.
      const third = await commit(storage, [insert(60)]);
      assert.equal((await changes.next()).value?.commit, second.commit);
      assert.equal((await changes.next()).value?.commit, third.commit);
      const waiting = changes.next();
      controller.abort();
      assert.equal((await waiting).done, true);
      const db = await hydb.database({ schema, storage });
      const query = hydb
        .query(rows)
        .where((value) => value.group.eq("other"))
        .select((value) => ({ title: value.title }))
        .many();
      assert.deepEqual(await db.fetch(query), [{ title: "Updated" }]);
      await db.close();
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const applyBeforeFailure of [false, true]) {
  test(`publication failure (${applyBeforeFailure ? "after" : "before"} backend apply) requires reopening`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydb-kv-failure-"));
    const backend = openLmdbKeyValueStore(directory);
    let fail = false;
    const wrapper: KeyValueStore = {
      ...backend,
      async batch(operations, conditions) {
        if (!fail || applyBeforeFailure)
          await backend.batch(operations, conditions);
        if (fail) throw new Error("injected I/O failure");
      },
    };
    const storage = await openKeyValueStorage({ schema, store: wrapper });
    try {
      const before = await storage.head();
      fail = true;
      await assert.rejects(commit(storage, [insert(1)]), /injected I\/O/);
      await assert.rejects(storage.head(), /requires reopening/);
      await storage.close();
      const reopened = await openKeyValueStorage({ schema, directory });
      try {
        const snapshot = await reopened.snapshot();
        assert.deepEqual(
          await snapshot.get(rows, ["001"]),
          applyBeforeFailure ? row(1) : undefined,
        );
        assert.equal((await reopened.head()) === before, !applyBeforeFailure);
        await snapshot.close();
        await commit(reopened, [insert(2)]);
      } finally {
        await reopened.close();
      }
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("head and snapshots stay on the old root until durable publication completes", async () => {
  const backend = memoryKeyValueStore();
  let release!: () => void;
  let entered!: () => void;
  let pause = false;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const storage = await openKeyValueStorage({
    schema,
    store: {
      ...backend,
      async batch(operations, conditions) {
        if (pause) {
          entered();
          await gate;
        }
        await backend.batch(operations, conditions);
      },
    },
  });
  try {
    const before = await storage.head();
    pause = true;
    const pending = commit(storage, [insert(1)]);
    await started;
    assert.equal(await storage.head(), before);
    const old = await storage.snapshot();
    assert.equal(await old.get(rows, ["001"]), undefined);
    release();
    const published = await pending;
    assert.equal(await storage.head(), published.commit);
    assert.equal(await old.get(rows, ["001"]), undefined);
    await old.close();
  } finally {
    release();
    await storage.close();
  }
});

test("a stale writer cannot overwrite committed pages or metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-kv-cas-"));
  const first = await openKeyValueStorage({ schema, directory });
  const second = await openKeyValueStorage({ schema, directory });
  try {
    const winner = await commit(first, [insert(1)]);
    await assert.rejects(commit(second, [insert(2)]), KeyValueConflictError);
    assert.equal(await first.head(), winner.commit);
    const snapshot = await first.snapshot();
    assert.deepEqual(await snapshot.get(rows, ["001"]), row(1));
    assert.equal(await snapshot.get(rows, ["002"]), undefined);
    await snapshot.close();
    await second.close();
    await commit(first, [insert(3)]);
  } finally {
    await second.close();
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema mismatches and unrelated stores are rejected; GC remains explicitly deferred", async () => {
  const unrelated = memoryKeyValueStore();
  await unrelated.batch([
    { type: "put", key: "unrelated", value: Uint8Array.of(1) },
  ]);
  await assert.rejects(
    openKeyValueStorage({ schema, store: unrelated }),
    /nonempty/,
  );
  const directory = await mkdtemp(join(tmpdir(), "hydb-kv-schema-"));
  try {
    const storage = await openKeyValueStorage({ schema, directory });
    await assert.rejects(storage.collectGarbage(), /step 3/);
    await storage.close();
    await assert.rejects(
      openKeyValueStorage({ schema: hydb.schema({}), directory }),
      /schema does not match/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}
