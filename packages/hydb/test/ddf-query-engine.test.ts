import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";

import {
  hydb,
  id,
  integer,
  json,
  memoryStorage,
  storageMutation,
  text,
} from "../src/index.js";

async function settleDataflow(): Promise<void> {
  await waitForImmediate();
}

test("subscriptions ignore changes outside a cyclic projection", async () => {
  type Payload = { label: string; self?: Payload };
  const records = hydb.table("cyclic_records", {
    id: id().primaryKey(),
    payload: json<Payload>().notNull(),
    revision: integer().notNull(),
  });
  const schema = hydb.schema({ records });
  const storage = await memoryStorage({ schema });

  const first: Payload = { label: "first" };
  first.self = first;
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(records, {
        id: "one",
        payload: first,
        revision: 1,
      }),
    ],
  });

  const db = await hydb.database({ schema, storage });
  const query = hydb
    .query(records)
    .select((record) => ({ id: record.id, payload: record.payload }))
    .require();
  const results: Array<Awaited<ReturnType<typeof db.fetch<typeof query>>>> = [];
  db.subscribe(query, (result) => results.push(result));

  await storage.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(records, ["one"], {
        id: "one",
        payload: first,
        revision: 2,
      }),
    ],
  });
  await waitForImmediate();

  try {
    assert.equal(results.length, 1);
    assert.equal(results[0]?.payload.label, "first");
    assert.equal(results[0]?.payload.self, results[0]?.payload);
  } finally {
    await db.close().catch(() => undefined);
  }
});

test("filter and top-k membership update through insert, update, and delete", async () => {
  const tasks = hydb.table("ddf_topk_tasks", {
    id: id().primaryKey(),
    title: text().notNull(),
    active: integer().notNull(),
    priority: integer().notNull(),
  });
  const schema = hydb.schema({ tasks });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, {
        id: "a",
        title: "A",
        active: 1,
        priority: 10,
      }),
      storageMutation.insert(tasks, {
        id: "b",
        title: "B",
        active: 1,
        priority: 5,
      }),
      storageMutation.insert(tasks, {
        id: "c",
        title: "C",
        active: 0,
        priority: 100,
      }),
    ],
  });

  const db = await hydb.database({ schema, storage });
  const query = hydb
    .query(tasks)
    .where((task) => task.active.eq(1))
    .orderBy((task) => [task.priority.desc(), task.id.asc()])
    .limit(2)
    .select((task) => ({ id: task.id, title: task.title }))
    .many();
  const results: Array<Awaited<ReturnType<typeof db.fetch<typeof query>>>> = [];
  db.subscribe(query, (result) => results.push(result));

  await storage.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(tasks, ["a"], {
        id: "a",
        title: "A updated",
        active: 1,
        priority: 1,
      }),
      storageMutation.delete(tasks, ["b"]),
      storageMutation.update(tasks, ["c"], {
        id: "c",
        title: "C activated",
        active: 1,
        priority: 50,
      }),
      storageMutation.insert(tasks, {
        id: "d",
        title: "D",
        active: 1,
        priority: 25,
      }),
    ],
  });
  await settleDataflow();

  assert.deepEqual(results, [
    [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ],
    [
      { id: "c", title: "C activated" },
      { id: "d", title: "D" },
    ],
  ]);
  assert.deepEqual(results.at(-1), await db.fetch(query));
  await db.close();
});

test("re-keying children updates nested lists, counts, exists, and empty defaults", async () => {
  const projects = hydb.table("ddf_rekey_projects", {
    id: id().primaryKey(),
    name: text().notNull(),
  });
  const tasks = hydb.table("ddf_rekey_tasks", {
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
        title: "Move me",
      }),
    ],
  });

  const db = await hydb.database({ schema, storage });
  const query = hydb
    .query(projects)
    .orderBy((project) => project.id.asc())
    .select((project) => ({
      id: project.id,
      tasks: hydb
        .query(tasks)
        .where((task) => task.projectId.eq(project.id))
        .orderBy((task) => task.id.asc())
        .select((task) => ({ id: task.id, title: task.title }))
        .many(),
      count: hydb
        .query(tasks)
        .where((task) => task.projectId.eq(project.id))
        .count(),
      exists: hydb
        .query(tasks)
        .where((task) => task.projectId.eq(project.id))
        .exists(),
    }))
    .many();
  const results: Array<Awaited<ReturnType<typeof db.fetch<typeof query>>>> = [];
  db.subscribe(query, (result) => results.push(result));

  await storage.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(tasks, ["t1"], {
        id: "t1",
        projectId: "p2",
        title: "Moved",
      }),
      storageMutation.insert(tasks, {
        id: "t2",
        projectId: "p1",
        title: "Replacement",
      }),
    ],
  });
  await settleDataflow();

  assert.equal(results.length, 2);
  assert.deepEqual(results.at(-1), [
    {
      id: "p1",
      tasks: [{ id: "t2", title: "Replacement" }],
      count: 1,
      exists: true,
    },
    {
      id: "p2",
      tasks: [{ id: "t1", title: "Moved" }],
      count: 1,
      exists: true,
    },
  ]);

  await storage.commit({
    expectedVersion: 2,
    mutations: [storageMutation.delete(tasks, ["t2"])],
  });
  await settleDataflow();
  assert.deepEqual(results.at(-1)?.[0], {
    id: "p1",
    tasks: [],
    count: 0,
    exists: false,
  });
  assert.deepEqual(results.at(-1), await db.fetch(query));
  await db.close();
});

test("a child committed before its new parent joins when the parent arrives", async () => {
  const folders = hydb.table("ddf_atomic_folders", {
    id: id().primaryKey(),
  });
  const files = hydb.table("ddf_atomic_files", {
    id: id().primaryKey(),
    folderId: id().notNull(),
  });
  const schema = hydb.schema({ folders, files });
  const storage = await memoryStorage({ schema });
  const db = await hydb.database({ schema, storage });
  const query = hydb
    .query(folders)
    .select((folder) => ({
      id: folder.id,
      files: hydb
        .query(files)
        .where((file) => file.folderId.eq(folder.id))
        .select((file) => ({ id: file.id }))
        .many(),
    }))
    .many();
  const results: Array<Awaited<ReturnType<typeof db.fetch<typeof query>>>> = [];
  db.subscribe(query, (result) => results.push(result));

  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(files, { id: "file", folderId: "folder" }),
      storageMutation.insert(folders, { id: "folder" }),
    ],
  });
  await settleDataflow();

  assert.deepEqual(results, [[], [{ id: "folder", files: [{ id: "file" }] }]]);
  await db.close();
});

test("grandchild updates propagate through multiple nested joins", async () => {
  const projects = hydb.table("ddf_deep_projects", {
    id: id().primaryKey(),
  });
  const tasks = hydb.table("ddf_deep_tasks", {
    id: id().primaryKey(),
    projectId: id().notNull(),
    assigneeId: id(),
  });
  const users = hydb.table("ddf_deep_users", {
    id: id().primaryKey(),
    name: text().notNull(),
  });
  const schema = hydb.schema({ projects, tasks, users });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(projects, { id: "p" }),
      storageMutation.insert(tasks, {
        id: "t",
        projectId: "p",
        assigneeId: "u",
      }),
      storageMutation.insert(users, { id: "u", name: "Before" }),
    ],
  });
  const db = await hydb.database({ schema, storage });
  const query = hydb
    .query(projects)
    .select((project) => ({
      tasks: hydb
        .query(tasks)
        .where((task) => task.projectId.eq(project.id))
        .select((task) => ({
          id: task.id,
          assignee: hydb
            .query(users)
            .where((user) => task.assigneeId.eq(user.id))
            .select((user) => ({ name: user.name }))
            .one(),
        }))
        .many(),
    }))
    .require();
  const results: Array<Awaited<ReturnType<typeof db.fetch<typeof query>>>> = [];
  db.subscribe(query, (result) => results.push(result));

  await storage.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(users, ["u"], { id: "u", name: "After" }),
    ],
  });
  await settleDataflow();

  assert.equal(results.length, 2);
  assert.equal(results.at(-1)?.tasks[0]?.assignee?.name, "After");
  assert.deepEqual(results.at(-1), await db.fetch(query));
  await db.close();
});

test("non-equality correlations use the correct fallback join", async () => {
  const parents = hydb.table("ddf_theta_parents", {
    id: id().primaryKey(),
    excluded: text().notNull(),
  });
  const children = hydb.table("ddf_theta_children", {
    id: id().primaryKey(),
    value: text().notNull(),
  });
  const schema = hydb.schema({ parents, children });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(parents, { id: "p", excluded: "x" }),
      storageMutation.insert(children, { id: "x", value: "x" }),
      storageMutation.insert(children, { id: "y", value: "y" }),
    ],
  });
  const db = await hydb.database({ schema, storage });
  const query = hydb
    .query(parents)
    .select((parent) => ({
      children: hydb
        .query(children)
        .where((child) => child.value.ne(parent.excluded))
        .select((child) => ({ id: child.id }))
        .many(),
    }))
    .require();
  const results: Array<Awaited<ReturnType<typeof db.fetch<typeof query>>>> = [];
  db.subscribe(query, (result) => results.push(result));

  await storage.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(parents, ["p"], { id: "p", excluded: "y" }),
    ],
  });
  await settleDataflow();

  assert.deepEqual(results, [
    { children: [{ id: "y" }] },
    { children: [{ id: "x" }] },
  ]);
  await db.close();
});

test("unsubscribed graphs stop publishing while other subscribers continue", async () => {
  const counters = hydb.table("ddf_unsubscribe_counters", {
    id: id().primaryKey(),
    value: integer().notNull(),
  });
  const schema = hydb.schema({ counters });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [storageMutation.insert(counters, { id: "c", value: 0 })],
  });
  const db = await hydb.database({ schema, storage });
  const query = hydb
    .query(counters)
    .select((counter) => ({ value: counter.value }))
    .require();
  const first: number[] = [];
  const second: number[] = [];
  let initialSubscriptions!: () => void;
  const initialized = new Promise<void>((resolve) => {
    initialSubscriptions = resolve;
  });
  const observeInitialization = () => {
    if (first.length === 1 && second.length === 1) initialSubscriptions();
  };
  const unsubscribe = db.subscribe(query, (result) => {
    first.push(result.value);
    observeInitialization();
  });
  db.subscribe(query, (result) => {
    second.push(result.value);
    observeInitialization();
  });
  await initialized;
  unsubscribe();

  await storage.commit({
    expectedVersion: 1,
    mutations: [storageMutation.update(counters, ["c"], { id: "c", value: 1 })],
  });
  await settleDataflow();

  assert.deepEqual(first, [0]);
  assert.deepEqual(second, [0, 1]);
  await db.close();
});
