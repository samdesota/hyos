import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";

import {
  hydb,
  id,
  index,
  memoryStorage,
  storageMutation,
  text,
  type StorageDatabase,
  type StorageScan,
} from "../src/index.js";

function recordScans(
  storage: StorageDatabase,
  scans: StorageScan[],
): StorageDatabase {
  return {
    async snapshot(selector) {
      const snapshot = await storage.snapshot(selector);
      return {
        commit: snapshot.commit,
        branch: snapshot.branch,
        sequence: snapshot.sequence,
        version: snapshot.version,
        get: (table, key) => snapshot.get(table, key),
        scan(request) {
          scans.push(request);
          return snapshot.scan(request);
        },
        close: () => snapshot.close(),
      };
    },
    head: (branch) => storage.head(branch),
    createBranch: (request) => storage.createBranch(request),
    commit: (request) => storage.commit(request),
    changes: (options) => storage.changes(options),
    retain: (request) => storage.retain(request),
    releaseRetention: (name) => storage.releaseRetention(name),
    collectGarbage: () => storage.collectGarbage(),
    close: () => storage.close(),
  };
}

test("an indexed subscription bootstraps without loading unrelated rows", async () => {
  const tasks = hydb.table(
    "indexed_subscription_tasks",
    {
      id: id().primaryKey(),
      status: text().notNull(),
      title: text().notNull(),
    },
    (columns) => [index("tasks_status_idx").on(columns.status)],
  );
  const schema = hydb.schema({ tasks });
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, {
        id: "doing",
        status: "doing",
        title: "Relevant",
      }),
      storageMutation.insert(tasks, {
        id: "done",
        status: "done",
        title: "Unrelated",
      }),
    ],
  });
  const scans: StorageScan[] = [];
  const db = await hydb.database({
    schema,
    storage: recordScans(underlying, scans),
  });
  const initial = new Promise<void>((resolve) => {
    db.subscribe(
      hydb
        .query(tasks)
        .where((task) => task.status.eq("doing"))
        .select((task) => ({ id: task.id, title: task.title }))
        .many(),
      (result) => {
        assert.deepEqual(result, [{ id: "doing", title: "Relevant" }]);
        resolve();
      },
    );
  });

  await initial;
  assert.deepEqual(scans, [
    {
      type: "index",
      table: tasks,
      index: "tasks_status_idx",
      key: ["doing"],
      range: { reverse: false },
    },
  ]);
  await db.close();
});

test("a newly matching parent loads its pre-existing correlated children before publishing", async () => {
  const projects = hydb.table(
    "demand_projects",
    {
      id: id().primaryKey(),
      status: text().notNull(),
    },
    (columns) => [index("projects_status_idx").on(columns.status)],
  );
  const tasks = hydb.table(
    "demand_tasks",
    {
      id: id().primaryKey(),
      projectId: id().notNull(),
      title: text().notNull(),
    },
    (columns) => [index("tasks_project_idx").on(columns.projectId)],
  );
  const schema = hydb.schema({ projects, tasks });
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(projects, { id: "p1", status: "active" }),
      storageMutation.insert(projects, { id: "p2", status: "archived" }),
      storageMutation.insert(tasks, {
        id: "t1",
        projectId: "p1",
        title: "Initially visible",
      }),
      storageMutation.insert(tasks, {
        id: "t2",
        projectId: "p2",
        title: "Already existed",
      }),
    ],
  });
  const scans: StorageScan[] = [];
  const db = await hydb.database({
    schema,
    storage: recordScans(underlying, scans),
  });
  const query = hydb
    .query(projects)
    .where((project) => project.status.eq("active"))
    .orderBy((project) => project.id.asc())
    .select((project) => ({
      id: project.id,
      tasks: hydb
        .query(tasks)
        .where((task) => task.projectId.eq(project.id))
        .orderBy((task) => task.id.asc())
        .select((task) => ({ id: task.id, title: task.title }))
        .many(),
    }))
    .many();
  const results: Array<Awaited<ReturnType<typeof db.fetch<typeof query>>>> = [];
  let announceInitial!: () => void;
  const initialized = new Promise<void>((resolve) => {
    announceInitial = resolve;
  });
  let announceUpdate!: () => void;
  const updated = new Promise<void>((resolve) => {
    announceUpdate = resolve;
  });
  db.subscribe(query, (result) => {
    results.push(result);
    if (results.length === 1) announceInitial();
    if (results.length === 2) announceUpdate();
  });

  await initialized;
  assert.deepEqual(results[0], [
    {
      id: "p1",
      tasks: [{ id: "t1", title: "Initially visible" }],
    },
  ]);
  assert.deepEqual(
    scans.map((scan) =>
      scan.type === "table" ? ["table"] : ["index", scan.index, scan.key],
    ),
    [
      ["index", "projects_status_idx", ["active"]],
      ["index", "tasks_project_idx", ["p1"]],
    ],
  );

  await underlying.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(projects, ["p2"], {
        id: "p2",
        status: "active",
      }),
      storageMutation.insert(tasks, {
        id: "t3",
        projectId: "p2",
        title: "Created with parent activation",
      }),
    ],
  });
  await updated;

  assert.deepEqual(results[1], [
    {
      id: "p1",
      tasks: [{ id: "t1", title: "Initially visible" }],
    },
    {
      id: "p2",
      tasks: [
        { id: "t2", title: "Already existed" },
        { id: "t3", title: "Created with parent activation" },
      ],
    },
  ]);
  assert.deepEqual(
    scans.map((scan) =>
      scan.type === "table" ? ["table"] : ["index", scan.index, scan.key],
    ),
    [
      ["index", "projects_status_idx", ["active"]],
      ["index", "tasks_project_idx", ["p1"]],
      ["index", "tasks_project_idx", ["p2"]],
    ],
  );
  await db.close();
});

test("shared child buckets are retained until their final parent leaves", async () => {
  const parents = hydb.table(
    "shared_demand_parents",
    {
      id: id().primaryKey(),
      groupId: id().notNull(),
      status: text().notNull(),
    },
    (columns) => [index("parents_status_idx").on(columns.status)],
  );
  const children = hydb.table(
    "shared_demand_children",
    {
      id: id().primaryKey(),
      groupId: id().notNull(),
    },
    (columns) => [index("children_group_idx").on(columns.groupId)],
  );
  const schema = hydb.schema({ parents, children });
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(parents, {
        id: "p1",
        groupId: "shared",
        status: "active",
      }),
      storageMutation.insert(parents, {
        id: "p2",
        groupId: "shared",
        status: "active",
      }),
      storageMutation.insert(children, { id: "c1", groupId: "shared" }),
    ],
  });
  const scans: StorageScan[] = [];
  const db = await hydb.database({
    schema,
    storage: recordScans(underlying, scans),
  });
  const query = hydb
    .query(parents)
    .where((parent) => parent.status.eq("active"))
    .orderBy((parent) => parent.id.asc())
    .select((parent) => ({
      id: parent.id,
      children: hydb
        .query(children)
        .where((child) => child.groupId.eq(parent.groupId))
        .orderBy((child) => child.id.asc())
        .select((child) => ({ id: child.id }))
        .many(),
    }))
    .many();
  const results: Array<Awaited<ReturnType<typeof db.fetch<typeof query>>>> = [];
  let nextResult!: () => void;
  let resultArrived = new Promise<void>((resolve) => {
    nextResult = resolve;
  });
  const waitForResult = async () => {
    await resultArrived;
    resultArrived = new Promise<void>((resolve) => {
      nextResult = resolve;
    });
  };
  db.subscribe(query, (result) => {
    results.push(result);
    nextResult();
  });
  await waitForResult();

  await underlying.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(parents, ["p1"], {
        id: "p1",
        groupId: "shared",
        status: "archived",
      }),
    ],
  });
  await waitForResult();
  await underlying.commit({
    expectedVersion: 2,
    mutations: [
      storageMutation.update(parents, ["p2"], {
        id: "p2",
        groupId: "shared",
        status: "archived",
      }),
    ],
  });
  await waitForResult();
  await underlying.commit({
    expectedVersion: 3,
    mutations: [
      storageMutation.insert(children, { id: "c2", groupId: "shared" }),
    ],
  });
  await underlying.commit({
    expectedVersion: 4,
    mutations: [
      storageMutation.update(parents, ["p1"], {
        id: "p1",
        groupId: "shared",
        status: "active",
      }),
    ],
  });
  await waitForResult();

  assert.deepEqual(results, [
    [
      { id: "p1", children: [{ id: "c1" }] },
      { id: "p2", children: [{ id: "c1" }] },
    ],
    [{ id: "p2", children: [{ id: "c1" }] }],
    [],
    [
      {
        id: "p1",
        children: [{ id: "c1" }, { id: "c2" }],
      },
    ],
  ]);
  assert.deepEqual(
    scans
      .filter(
        (scan) => scan.type === "index" && scan.index === "children_group_idx",
      )
      .map((scan) => scan.type === "index" && scan.key),
    [["shared"], ["shared"]],
  );
  await db.close();
});

test("subscription bootstrap follows correlated index demands to a fixpoint", async () => {
  const projects = hydb.table(
    "fixpoint_projects",
    {
      id: id().primaryKey(),
      status: text().notNull(),
    },
    (columns) => [index("fixpoint_projects_status_idx").on(columns.status)],
  );
  const tasks = hydb.table(
    "fixpoint_tasks",
    {
      id: id().primaryKey(),
      projectId: id().notNull(),
    },
    (columns) => [index("fixpoint_tasks_project_idx").on(columns.projectId)],
  );
  const comments = hydb.table(
    "fixpoint_comments",
    {
      id: id().primaryKey(),
      taskId: id().notNull(),
      body: text().notNull(),
    },
    (columns) => [index("fixpoint_comments_task_idx").on(columns.taskId)],
  );
  const schema = hydb.schema({ projects, tasks, comments });
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(projects, { id: "p1", status: "active" }),
      storageMutation.insert(projects, { id: "p2", status: "archived" }),
      storageMutation.insert(tasks, { id: "t1", projectId: "p1" }),
      storageMutation.insert(tasks, { id: "t2", projectId: "p2" }),
      storageMutation.insert(comments, {
        id: "c1",
        taskId: "t1",
        body: "Loaded",
      }),
      storageMutation.insert(comments, {
        id: "c2",
        taskId: "t2",
        body: "Unrelated",
      }),
    ],
  });
  const scans: StorageScan[] = [];
  const db = await hydb.database({
    schema,
    storage: recordScans(underlying, scans),
  });
  const query = hydb
    .query(projects)
    .where((project) => project.status.eq("active"))
    .select((project) => ({
      id: project.id,
      tasks: hydb
        .query(tasks)
        .where((task) => task.projectId.eq(project.id))
        .select((task) => ({
          id: task.id,
          comments: hydb
            .query(comments)
            .where((comment) => comment.taskId.eq(task.id))
            .select((comment) => ({ id: comment.id, body: comment.body }))
            .many(),
        }))
        .many(),
    }))
    .many();
  const initial = new Promise<void>((resolve) => {
    db.subscribe(query, (result) => {
      assert.deepEqual(result, [
        {
          id: "p1",
          tasks: [
            {
              id: "t1",
              comments: [{ id: "c1", body: "Loaded" }],
            },
          ],
        },
      ]);
      resolve();
    });
  });

  await initial;
  assert.deepEqual(
    scans.map((scan) =>
      scan.type === "table" ? ["table"] : ["index", scan.index, scan.key],
    ),
    [
      ["index", "fixpoint_projects_status_idx", ["active"]],
      ["index", "fixpoint_tasks_project_idx", ["p1"]],
      ["index", "fixpoint_comments_task_idx", ["t1"]],
    ],
  );
  await db.close();
});

test("unsubscribing during a bucket load does not fail the change stream", async () => {
  const parents = hydb.table("cancel_demand_parents", {
    id: id().primaryKey(),
    active: text().notNull(),
  });
  const children = hydb.table(
    "cancel_demand_children",
    {
      id: id().primaryKey(),
      parentId: id().notNull(),
    },
    (columns) => [index("cancel_children_parent_idx").on(columns.parentId)],
  );
  const schema = hydb.schema({ parents, children });
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(parents, { id: "p1", active: "no" }),
      storageMutation.insert(children, { id: "c1", parentId: "p1" }),
    ],
  });
  let announceScan!: () => void;
  const scanStarted = new Promise<void>((resolve) => {
    announceScan = resolve;
  });
  let resumeScan!: () => void;
  const scanResumed = new Promise<void>((resolve) => {
    resumeScan = resolve;
  });
  const storage: StorageDatabase = {
    async snapshot(selector) {
      const snapshot = await underlying.snapshot(selector);
      return {
        commit: snapshot.commit,
        branch: snapshot.branch,
        sequence: snapshot.sequence,
        version: snapshot.version,
        get: (table, key) => snapshot.get(table, key),
        async *scan(request) {
          if (
            request.type === "index" &&
            request.index === "cancel_children_parent_idx"
          ) {
            announceScan();
            await scanResumed;
          }
          yield* snapshot.scan(request);
        },
        close: () => snapshot.close(),
      };
    },
    head: (branch) => underlying.head(branch),
    createBranch: (request) => underlying.createBranch(request),
    commit: (request) => underlying.commit(request),
    changes: (options) => underlying.changes(options),
    retain: (request) => underlying.retain(request),
    releaseRetention: (name) => underlying.releaseRetention(name),
    collectGarbage: () => underlying.collectGarbage(),
    close: () => underlying.close(),
  };
  const db = await hydb.database({ schema, storage });
  const results: unknown[] = [];
  let announceInitial!: () => void;
  const initialized = new Promise<void>((resolve) => {
    announceInitial = resolve;
  });
  const unsubscribe = db.subscribe(
    hydb
      .query(parents)
      .where((parent) => parent.active.eq("yes"))
      .select((parent) => ({
        id: parent.id,
        children: hydb
          .query(children)
          .where((child) => child.parentId.eq(parent.id))
          .many(),
      }))
      .many(),
    (result) => {
      results.push(result);
      announceInitial();
    },
  );
  await initialized;
  await underlying.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(parents, ["p1"], {
        id: "p1",
        active: "yes",
      }),
    ],
  });
  await scanStarted;
  unsubscribe();
  resumeScan();
  await waitForImmediate();

  assert.deepEqual(results, [[]]);
  await db.close();
});

test("subscription access keeps enough indexed candidates to refill top-k", async () => {
  const tasks = hydb.table(
    "topk_subscription_tasks",
    {
      id: id().primaryKey(),
      status: text().notNull(),
      priority: text().notNull(),
    },
    (columns) => [
      index("topk_tasks_status_priority_idx").on(
        columns.status,
        columns.priority,
      ),
    ],
  );
  const schema = hydb.schema({ tasks });
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, {
        id: "high",
        status: "doing",
        priority: "2",
      }),
      storageMutation.insert(tasks, {
        id: "low",
        status: "doing",
        priority: "1",
      }),
      storageMutation.insert(tasks, {
        id: "done",
        status: "done",
        priority: "9",
      }),
    ],
  });
  const scans: StorageScan[] = [];
  const db = await hydb.database({
    schema,
    storage: recordScans(underlying, scans),
  });
  const query = hydb
    .query(tasks)
    .where((task) => task.status.eq("doing"))
    .orderBy((task) => task.priority.desc())
    .limit(1)
    .select((task) => ({ id: task.id }))
    .many();
  const results: Array<Awaited<ReturnType<typeof db.fetch<typeof query>>>> = [];
  let announceResult!: () => void;
  let resultArrived = new Promise<void>((resolve) => {
    announceResult = resolve;
  });
  const waitForResult = async () => {
    await resultArrived;
    resultArrived = new Promise<void>((resolve) => {
      announceResult = resolve;
    });
  };
  db.subscribe(query, (result) => {
    results.push(result);
    announceResult();
  });
  await waitForResult();
  await underlying.commit({
    expectedVersion: 1,
    mutations: [storageMutation.delete(tasks, ["high"])],
  });
  await waitForResult();

  assert.deepEqual(results, [[{ id: "high" }], [{ id: "low" }]]);
  assert.equal(scans.length, 1);
  assert.deepEqual(scans[0], {
    type: "index",
    table: tasks,
    index: "topk_tasks_status_priority_idx",
    key: ["doing"],
    range: { reverse: true },
  });
  await db.close();
});
