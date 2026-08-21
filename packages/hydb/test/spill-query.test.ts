import assert from "node:assert/strict";
import test from "node:test";

import {
  hydb,
  id,
  integer,
  memorySpillStore,
  memoryStorage,
  SpillLimitExceededError,
  storageMutation,
  text,
} from "../src/index.js";

test("fetch externally sorts under a tiny working-memory budget", async () => {
  const tasks = hydb.table("spill_sort_tasks", {
    id: id().primaryKey(),
    priority: integer().notNull(),
    title: text().notNull(),
  });
  const schema = hydb.schema({ tasks });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      ["a", 5],
      ["b", 1],
      ["c", 4],
      ["d", 2],
      ["e", 3],
      ["f", 1],
    ].map(([taskId, priority]) =>
      storageMutation.insert(tasks, {
        id: taskId as string,
        priority: priority as number,
        title: `Task ${taskId} ${"x".repeat(80)}`,
      }),
    ),
  });
  const spill = memorySpillStore({ maxBytes: 64 * 1024 });
  const db = await hydb.database({
    schema,
    storage,
    spill: { store: spill, memoryBytes: 300 },
  });
  const query = hydb
    .query(tasks)
    .orderBy((task) => [task.priority.asc()])
    .select((task) => ({ id: task.id, priority: task.priority }))
    .many();

  assert.deepEqual(await db.fetch(query), [
    { id: "b", priority: 1 },
    { id: "f", priority: 1 },
    { id: "d", priority: 2 },
    { id: "e", priority: 3 },
    { id: "c", priority: 4 },
    { id: "a", priority: 5 },
  ]);
  assert.ok(spill.stats().bytesWritten > 0);
  assert.equal(spill.stats().usedBytes, 0);
  assert.equal(spill.stats().sessions, 0);
  await db.close();
  await spill.close();
});

test("a small configured sort stays on the in-memory fast path", async () => {
  const rows = hydb.table("spill_fast_rows", {
    id: id().primaryKey(),
    rank: integer().notNull(),
  });
  const schema = hydb.schema({ rows });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(rows, { id: "two", rank: 2 }),
      storageMutation.insert(rows, { id: "one", rank: 1 }),
    ],
  });
  const spill = memorySpillStore({ maxBytes: 1024 });
  const db = await hydb.database({
    schema,
    storage,
    spill: { store: spill, memoryBytes: 1024 * 1024 },
  });

  assert.deepEqual(
    await db.fetch(
      hydb
        .query(rows)
        .orderBy((row) => [row.rank.asc()])
        .many(),
    ),
    [
      { id: "one", rank: 1 },
      { id: "two", rank: 2 },
    ],
  );
  assert.equal(spill.stats().bytesWritten, 0);
  assert.equal(spill.stats().sessions, 0);
  await db.close();
  await spill.close();
});

test("fetch cleans partial runs when the spill disk budget is exhausted", async () => {
  const rows = hydb.table("spill_limit_rows", {
    id: id().primaryKey(),
    rank: integer().notNull(),
    payload: text().notNull(),
  });
  const schema = hydb.schema({ rows });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(rows, {
        id: "one",
        rank: 2,
        payload: "x".repeat(200),
      }),
      storageMutation.insert(rows, {
        id: "two",
        rank: 1,
        payload: "y".repeat(200),
      }),
    ],
  });
  const spill = memorySpillStore({ maxBytes: 32 });
  const db = await hydb.database({
    schema,
    storage,
    spill: { store: spill, memoryBytes: 1 },
  });

  await assert.rejects(
    db.fetch(
      hydb
        .query(rows)
        .orderBy((row) => [row.rank.asc()])
        .many(),
    ),
    SpillLimitExceededError,
  );
  assert.equal(spill.stats().usedBytes, 0);
  assert.equal(spill.stats().sessions, 0);
  await db.close();
  await spill.close();
});

test("fetch spills and reuses a hash join for an unindexed correlation", async () => {
  const projects = hydb.table("spill_join_projects", {
    id: id().primaryKey(),
    name: text().notNull(),
  });
  const tasks = hydb.table("spill_join_tasks", {
    id: id().primaryKey(),
    projectId: id().notNull(),
    title: text().notNull(),
  });
  const schema = hydb.schema({ projects, tasks });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(projects, { id: "p1", name: "One" }),
      storageMutation.insert(projects, { id: "p2", name: "Two" }),
      storageMutation.insert(tasks, {
        id: "t1",
        projectId: "p1",
        title: `First ${"x".repeat(100)}`,
      }),
      storageMutation.insert(tasks, {
        id: "t2",
        projectId: "p2",
        title: `Second ${"x".repeat(100)}`,
      }),
      storageMutation.insert(tasks, {
        id: "t3",
        projectId: "p1",
        title: `Third ${"x".repeat(100)}`,
      }),
    ],
  });
  const spill = memorySpillStore({ maxBytes: 64 * 1024 });
  const db = await hydb.database({
    schema,
    storage,
    spill: { store: spill, memoryBytes: 256 },
  });
  const query = hydb
    .query(projects)
    .select((project) => ({
      id: project.id,
      tasks: hydb
        .query(tasks)
        .where((task) => task.projectId.eq(project.id))
        .orderBy((task) => [task.title.asc()])
        .limit(2)
        .select((task) => ({ id: task.id }))
        .many(),
    }))
    .many();

  assert.deepEqual(await db.fetch(query), [
    { id: "p1", tasks: [{ id: "t1" }, { id: "t3" }] },
    { id: "p2", tasks: [{ id: "t2" }] },
  ]);
  assert.ok(spill.stats().bytesWritten > 0);
  assert.equal(spill.stats().usedBytes, 0);
  await db.close();
  await spill.close();
});

test("subscribe spills differential join arrangements and settles before publishing", async () => {
  const projects = hydb.table("spill_live_projects", {
    id: id().primaryKey(),
  });
  const tasks = hydb.table("spill_live_tasks", {
    id: id().primaryKey(),
    projectId: id().notNull(),
    title: text().notNull(),
  });
  const schema = hydb.schema({ projects, tasks });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(projects, { id: "p1" }),
      storageMutation.insert(tasks, {
        id: "t1",
        projectId: "p1",
        title: `One ${"x".repeat(100)}`,
      }),
      storageMutation.insert(tasks, {
        id: "t2",
        projectId: "p1",
        title: `Two ${"x".repeat(100)}`,
      }),
    ],
  });
  const spill = memorySpillStore({ maxBytes: 64 * 1024 });
  const db = await hydb.database({
    schema,
    storage,
    spill: { store: spill, memoryBytes: 200 },
  });
  const query = hydb
    .query(projects)
    .select((project) => ({
      id: project.id,
      tasks: hydb
        .query(tasks)
        .where((task) => task.projectId.eq(project.id))
        .orderBy((task) => [task.title.asc()])
        .limit(2)
        .select((task) => ({ id: task.id }))
        .many(),
    }))
    .many();
  const results: unknown[] = [];
  let resolveInitial!: () => void;
  const initial = new Promise<void>((resolve) => {
    resolveInitial = resolve;
  });
  const unsubscribe = db.subscribe(query, (result) => {
    results.push(result);
    resolveInitial();
  });
  await initial;

  assert.deepEqual(results, [
    [{ id: "p1", tasks: [{ id: "t1" }, { id: "t2" }] }],
  ]);
  assert.ok(spill.stats().bytesWritten > 0);
  assert.ok(spill.stats().usedBytes > 0);

  const snapshot = await storage.snapshot();
  await storage.commit({
    expectedHead: snapshot.commit,
    mutations: [
      storageMutation.insert(tasks, {
        id: "t3",
        projectId: "p1",
        title: "Three",
      }),
    ],
  });
  await snapshot.close();
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (results.length === 2) resolve();
      else setTimeout(check, 0);
    };
    check();
  });
  assert.deepEqual(results[1], [
    { id: "p1", tasks: [{ id: "t1" }, { id: "t3" }] },
  ]);

  const secondSnapshot = await storage.snapshot();
  await storage.commit({
    expectedHead: secondSnapshot.commit,
    mutations: [
      storageMutation.insert(projects, { id: "p2" }),
      storageMutation.insert(tasks, {
        id: "t4",
        projectId: "p2",
        title: "Same commit",
      }),
    ],
  });
  await secondSnapshot.close();
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (results.length === 3) resolve();
      else setTimeout(check, 0);
    };
    check();
  });
  assert.deepEqual(results[2], [
    { id: "p1", tasks: [{ id: "t1" }, { id: "t3" }] },
    { id: "p2", tasks: [{ id: "t4" }] },
  ]);

  const thirdSnapshot = await storage.snapshot();
  await storage.commit({
    expectedHead: thirdSnapshot.commit,
    mutations: [
      storageMutation.update(tasks, ["t1"], {
        id: "t1",
        projectId: "p1",
        title: "Zulu",
      }),
    ],
  });
  await thirdSnapshot.close();
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (results.length === 4) resolve();
      else setTimeout(check, 0);
    };
    check();
  });
  assert.deepEqual(results[3], [
    { id: "p1", tasks: [{ id: "t3" }, { id: "t2" }] },
    { id: "p2", tasks: [{ id: "t4" }] },
  ]);

  unsubscribe();
  await db.close();
  assert.equal(spill.stats().usedBytes, 0);
  await spill.close();
});
