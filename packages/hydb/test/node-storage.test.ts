import assert from "node:assert/strict";
import { mkdtemp, rm, stat, truncate } from "node:fs/promises";
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
} from "../src/index.js";
import {
  ByteLruCache,
  encodeOrderedKey,
  openNodeStorage,
} from "../src/node/index.js";

const tasks = hydb.table(
  "tasks",
  {
    id: id().primaryKey(),
    projectId: id().notNull(),
    title: text().notNull(),
  },
  (columns) => [index("tasks_project_idx").on(columns.projectId)],
);
const schema = hydb.schema({ tasks });

test("node storage reopens committed rows and historical index roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-node-"));

  try {
    const storage = await openNodeStorage({ directory, schema });
    const initial = await storage.snapshot();
    const first = await storage.commit({
      branch: "main",
      expectedHead: initial.commit,
      mutations: [
        storageMutation.insert(tasks, {
          id: "task-1",
          projectId: "project-1",
          title: "First",
        }),
      ],
    });
    await initial.close();
    await storage.close();

    const reopened = await openNodeStorage({ directory, schema });
    const historical = await reopened.snapshot({ commit: first.commit });
    assert.deepEqual(await historical.get(tasks, ["task-1"]), {
      id: "task-1",
      projectId: "project-1",
      title: "First",
    });

    const rows = [];
    for await (const batch of historical.scan({
      type: "index",
      table: tasks,
      index: "tasks_project_idx",
      key: ["project-1"],
    })) {
      rows.push(...batch);
    }
    assert.deepEqual(rows, [
      {
        id: "task-1",
        projectId: "project-1",
        title: "First",
      },
    ]);

    await historical.close();
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("branches diverge from an arbitrary commit without changing historical snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-branch-"));
  try {
    const storage = await openNodeStorage({ directory, schema, maxEntries: 4 });
    const initial = await storage.snapshot();
    const base = await storage.commit({
      expectedHead: initial.commit,
      mutations: [
        storageMutation.insert(tasks, {
          id: "task-1",
          projectId: "project-1",
          title: "Base",
        }),
      ],
    });
    await storage.createBranch({ name: "feature", from: base.commit });
    const branchStart = await storage.snapshot({ branch: "feature" });
    assert.equal(branchStart.commit, base.commit);
    assert.equal(branchStart.sequence, 0);
    await branchStart.close();

    const main = await storage.commit({
      branch: "main",
      expectedHead: base.commit,
      mutations: [
        storageMutation.update(tasks, ["task-1"], {
          id: "task-1",
          projectId: "project-1",
          title: "Main",
        }),
      ],
    });
    const feature = await storage.commit({
      branch: "feature",
      expectedHead: base.commit,
      mutations: [
        storageMutation.update(tasks, ["task-1"], {
          id: "task-1",
          projectId: "project-2",
          title: "Feature",
        }),
      ],
    });

    assert.notEqual(main.commit, feature.commit);
    assert.equal((await storage.snapshot({ branch: "main" })).version, 2);
    assert.equal((await storage.snapshot({ branch: "feature" })).version, 1);
    assert.equal(
      (
        await (
          await storage.snapshot({ commit: base.commit })
        ).get(tasks, ["task-1"])
      )?.title,
      "Base",
    );
    assert.equal(
      (
        await (
          await storage.snapshot({ branch: "main" })
        ).get(tasks, ["task-1"])
      )?.title,
      "Main",
    );
    assert.deepEqual(
      await (
        await storage.snapshot({ branch: "feature" })
      ).get(tasks, ["task-1"]),
      {
        id: "task-1",
        projectId: "project-2",
        title: "Feature",
      },
    );

    await storage.close();
    const reopened = await openNodeStorage({
      directory,
      schema,
      maxEntries: 4,
    });
    assert.equal(await reopened.head("main"), main.commit);
    assert.equal(await reopened.head("feature"), feature.commit);
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("small B+ tree pages split while old roots survive deletes and cache eviction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-tree-"));
  try {
    const storage = await openNodeStorage({
      directory,
      schema,
      maxEntries: 4,
      cacheBytes: 512,
    });
    const initial = await storage.snapshot();
    const inserted = await storage.commit({
      expectedHead: initial.commit,
      mutations: Array.from({ length: 100 }, (_, indexValue) => {
        const value = String(indexValue).padStart(3, "0");
        return storageMutation.insert(tasks, {
          id: `task-${value}`,
          projectId: `project-${indexValue % 5}`,
          title: `Task ${value}`,
        });
      }),
    });
    const deleted = await storage.commit({
      expectedHead: inserted.commit,
      mutations: Array.from({ length: 50 }, (_, indexValue) =>
        storageMutation.delete(tasks, [
          `task-${String(indexValue * 2 + 1).padStart(3, "0")}`,
        ]),
      ),
    });

    const collectIds = async (commit: string): Promise<string[]> => {
      const snapshot = await storage.snapshot({ commit });
      const ids: string[] = [];
      for await (const batch of snapshot.scan({
        type: "table",
        table: tasks,
      })) {
        ids.push(...batch.map((row) => row.id));
      }
      await snapshot.close();
      return ids;
    };

    assert.equal((await collectIds(inserted.commit)).length, 100);
    assert.deepEqual(
      await collectIds(deleted.commit),
      Array.from(
        { length: 50 },
        (_, indexValue) => `task-${String(indexValue * 2).padStart(3, "0")}`,
      ),
    );
    const ranged = await storage.snapshot({ commit: deleted.commit });
    const rangedIds: string[] = [];
    for await (const batch of ranged.scan({
      type: "table",
      table: tasks,
      range: {
        gte: ["task-020"],
        lt: ["task-030"],
        reverse: true,
        limit: 3,
      },
    })) {
      rangedIds.push(...batch.map((row) => row.id));
    }
    assert.deepEqual(rangedIds, ["task-028", "task-026", "task-024"]);
    await ranged.close();
    const emptied = await storage.commit({
      expectedHead: deleted.commit,
      mutations: Array.from({ length: 50 }, (_, indexValue) =>
        storageMutation.delete(tasks, [
          `task-${String(indexValue * 2).padStart(3, "0")}`,
        ]),
      ),
    });
    assert.deepEqual(await collectIds(emptied.commit), []);
    assert.equal((await collectIds(inserted.commit)).length, 100);
    assert.ok(storage.cacheStats().residentBytes <= 512);
    assert.ok(storage.cacheStats().evictions > 0);
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unique secondary-index conflicts do not publish partial commits", async () => {
  const accounts = hydb.table(
    "accounts",
    { id: id().primaryKey(), email: text().notNull() },
    (columns) => [uniqueIndex("accounts_email_unique").on(columns.email)],
  );
  const accountSchema = hydb.schema({ accounts });
  const directory = await mkdtemp(join(tmpdir(), "hydb-unique-"));
  try {
    const storage = await openNodeStorage({ directory, schema: accountSchema });
    const initial = await storage.snapshot();
    const first = await storage.commit({
      expectedHead: initial.commit,
      mutations: [
        storageMutation.insert(accounts, {
          id: "one",
          email: "same@example.com",
        }),
      ],
    });
    await assert.rejects(
      storage.commit({
        expectedHead: first.commit,
        mutations: [
          storageMutation.insert(accounts, {
            id: "two",
            email: "other@example.com",
          }),
          storageMutation.insert(accounts, {
            id: "three",
            email: "same@example.com",
          }),
        ],
      }),
      /Unique index accounts_email_unique rejected a duplicate key/,
    );
    assert.equal(await storage.head(), first.commit);
    assert.equal(
      await (await storage.snapshot()).get(accounts, ["two"]),
      undefined,
    );
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordered key bytes preserve supported scalar ordering", () => {
  const values = [-100, -1, 0, 0.5, 9, 100];
  const encoded = values.map((value) => encodeOrderedKey([value]));
  assert.deepEqual(
    [...encoded].sort(Buffer.compare).map((value) => encoded.indexOf(value)),
    [0, 1, 2, 3, 4, 5],
  );
  assert.ok(
    Buffer.compare(encodeOrderedKey(["a"]), encodeOrderedKey(["aa"])) < 0,
  );
  assert.ok(
    Buffer.compare(
      encodeOrderedKey([new Date("1960-01-01")]),
      encodeOrderedKey([new Date("2030-01-01")]),
    ) < 0,
  );
  assert.ok(
    Buffer.compare(encodeOrderedKey([null]), encodeOrderedKey([false])) < 0,
  );
  assert.ok(
    Buffer.compare(encodeOrderedKey([false]), encodeOrderedKey([true])) < 0,
  );
  assert.doesNotThrow(() => encodeOrderedKey(["contains\0zero", -0]));
  assert.throws(
    () => encodeOrderedKey([Number.POSITIVE_INFINITY]),
    /finite numbers/,
  );
});

test("the byte cache coalesces misses and remains within its hard limit", async () => {
  let loads = 0;
  const cache = new ByteLruCache(
    6,
    async (key: string) => {
      loads += 1;
      return key.repeat(3);
    },
    (value) => value.length,
  );
  assert.deepEqual(await Promise.all([cache.get("a"), cache.get("a")]), [
    "aaa",
    "aaa",
  ]);
  await cache.get("b");
  await cache.get("c");
  assert.equal(loads, 3);
  assert.ok(cache.stats().residentBytes <= 6);
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.reclaim(3), 3);
  assert.equal(cache.stats().residentBytes, 3);
  cache.setMaxBytes(0);
  assert.equal(cache.stats().residentBytes, 0);
});

test("the byte cache rejects invalid budgets and never retains oversized or failed loads", async () => {
  assert.throws(
    () =>
      new ByteLruCache(
        -1,
        async () => "",
        (value) => value.length,
      ),
    /non-negative safe integer/,
  );
  let oversizedLoads = 0;
  const oversized = new ByteLruCache(
    2,
    async () => {
      oversizedLoads += 1;
      return "large";
    },
    (value) => value.length,
  );
  await oversized.get("value");
  await oversized.get("value");
  assert.equal(oversizedLoads, 2);
  assert.equal(oversized.stats().entries, 0);
  assert.throws(() => oversized.setMaxBytes(-1), /non-negative safe integer/);

  let attempts = 0;
  const failing = new ByteLruCache(
    10,
    async () => {
      attempts += 1;
      throw new Error("load failed");
    },
    () => 1,
  );
  await assert.rejects(failing.get("page"), /load failed/);
  await assert.rejects(failing.get("page"), /load failed/);
  assert.equal(attempts, 2);
  failing.clear();
});

test("recovery ignores a torn commit publication and keeps the prior branch head", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-recovery-"));
  const dataPath = join(directory, "hydb.data");
  try {
    const storage = await openNodeStorage({ directory, schema });
    const initial = await storage.snapshot();
    const first = await storage.commit({
      expectedHead: initial.commit,
      mutations: [
        storageMutation.insert(tasks, {
          id: "task-1",
          projectId: "project-1",
          title: "Durable",
        }),
      ],
    });
    await storage.commit({
      expectedHead: first.commit,
      mutations: [
        storageMutation.insert(tasks, {
          id: "task-2",
          projectId: "project-1",
          title: "Torn",
        }),
      ],
    });
    await storage.close();

    const size = (await stat(dataPath)).size;
    await truncate(dataPath, size - 5);

    const recovered = await openNodeStorage({ directory, schema });
    assert.equal(await recovered.head(), first.commit);
    const snapshot = await recovered.snapshot();
    assert.equal((await snapshot.get(tasks, ["task-1"]))?.title, "Durable");
    assert.equal(await snapshot.get(tasks, ["task-2"]), undefined);
    await recovered.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("randomized mutations agree with an independent map after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-model-"));
  const shuffled = Array.from({ length: 120 }, (_, indexValue) => indexValue);
  let seed = 0x5eed;
  for (let indexValue = shuffled.length - 1; indexValue > 0; indexValue -= 1) {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    const target = seed % (indexValue + 1);
    [shuffled[indexValue], shuffled[target]] = [
      shuffled[target]!,
      shuffled[indexValue]!,
    ];
  }

  try {
    const storage = await openNodeStorage({ directory, schema, maxEntries: 5 });
    const initial = await storage.snapshot();
    const model = new Map<
      string,
      { id: string; projectId: string; title: string }
    >();
    const inserted = await storage.commit({
      expectedHead: initial.commit,
      mutations: shuffled.map((numberValue) => {
        const idValue = `task-${String(numberValue).padStart(3, "0")}`;
        const row = {
          id: idValue,
          projectId: `project-${numberValue % 7}`,
          title: `Initial ${numberValue}`,
        };
        model.set(idValue, row);
        return storageMutation.insert(tasks, row);
      }),
    });
    const changed = await storage.commit({
      expectedHead: inserted.commit,
      mutations: shuffled.slice(0, 70).map((numberValue, position) => {
        const idValue = `task-${String(numberValue).padStart(3, "0")}`;
        if (position % 3 === 0) {
          model.delete(idValue);
          return storageMutation.delete(tasks, [idValue]);
        }
        const row = {
          id: idValue,
          projectId: `project-${(numberValue + 1) % 7}`,
          title: `Updated ${numberValue}`,
        };
        model.set(idValue, row);
        return storageMutation.update(tasks, [idValue], row);
      }),
    });
    await storage.close();

    const reopened = await openNodeStorage({
      directory,
      schema,
      maxEntries: 5,
    });
    assert.equal(await reopened.head(), changed.commit);
    const snapshot = await reopened.snapshot();
    const actual = [];
    for await (const batch of snapshot.scan({ type: "table", table: tasks })) {
      actual.push(...batch);
    }
    assert.deepEqual(
      actual,
      [...model.values()].sort((a, b) => a.id.localeCompare(b.id)),
    );
    await snapshot.close();
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the existing query runtime can use node storage through the shared interface", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-query-"));
  try {
    const storage = await openNodeStorage({ directory, schema });
    const initial = await storage.snapshot();
    await storage.commit({
      expectedHead: initial.commit,
      mutations: [
        storageMutation.insert(tasks, {
          id: "task-2",
          projectId: "project-1",
          title: "Second",
        }),
        storageMutation.insert(tasks, {
          id: "task-1",
          projectId: "project-1",
          title: "First",
        }),
      ],
    });
    const db = await hydb.database({ schema, storage });
    const query = hydb
      .query(tasks)
      .where((task) => task.projectId.eq("project-1"))
      .orderBy((task) => task.id.asc())
      .select((task) => ({ id: task.id, title: task.title }))
      .many();
    assert.deepEqual(await db.fetch(query), [
      { id: "task-1", title: "First" },
      { id: "task-2", title: "Second" },
    ]);
    await db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("branch change sequences replay after restart without gaps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-changes-"));
  try {
    const storage = await openNodeStorage({ directory, schema });
    const initial = await storage.snapshot();
    const first = await storage.commit({
      expectedHead: initial.commit,
      mutations: [
        storageMutation.insert(tasks, {
          id: "task-1",
          projectId: "project-1",
          title: "First",
        }),
      ],
    });
    const second = await storage.commit({
      expectedHead: first.commit,
      mutations: [
        storageMutation.update(tasks, ["task-1"], {
          id: "task-1",
          projectId: "project-1",
          title: "Second",
        }),
      ],
    });
    await storage.close();

    const reopened = await openNodeStorage({ directory, schema });
    const controller = new AbortController();
    const changes = reopened
      .changes({ after: 0, signal: controller.signal })
      [Symbol.asyncIterator]();
    assert.equal((await changes.next()).value?.commit, first.commit);
    assert.equal((await changes.next()).value?.commit, second.commit);
    controller.abort();
    await changes.return?.();
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
