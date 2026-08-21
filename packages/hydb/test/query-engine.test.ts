import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";

import {
  hydb,
  id,
  index,
  integer,
  memoryStorage,
  storageMutation,
  text,
  type StorageDatabase,
  type StorageSnapshot,
} from "../src/index.js";

const taskStatus = hydb.enum("task_status", ["todo", "doing", "done"]);

const tasks = hydb.table(
  "tasks",
  {
    id: id().primaryKey(),
    title: text().notNull(),
    status: taskStatus().notNull(),
    priority: integer().notNull(),
  },
  (columns) => [
    index("tasks_status_priority_idx").on(columns.status, columns.priority),
  ],
);

const schema = hydb.schema({ tasks });

function recordStorageOperations(
  storage: StorageDatabase,
  operations: string[],
): StorageDatabase {
  return {
    async snapshot(selector) {
      operations.push("snapshot");
      const snapshot = await storage.snapshot(selector);
      const recorded: StorageSnapshot = {
        commit: snapshot.commit,
        branch: snapshot.branch,
        sequence: snapshot.sequence,
        version: snapshot.version,
        async get(table, key) {
          operations.push("get");
          return snapshot.get(table, key);
        },
        scan(request) {
          operations.push(
            request.type === "index" ? `index:${request.index}` : "table-scan",
          );
          return snapshot.scan(request);
        },
        close() {
          return snapshot.close();
        },
      };
      return recorded;
    },
    head(branch) {
      return storage.head(branch);
    },
    createBranch(request) {
      return storage.createBranch(request);
    },
    commit(request) {
      return storage.commit(request);
    },
    changes(options) {
      return storage.changes(options);
    },
    retain(request) {
      return storage.retain(request);
    },
    releaseRetention(name) {
      return storage.releaseRetention(name);
    },
    collectGarbage() {
      return storage.collectGarbage();
    },
    close() {
      return storage.close();
    },
  };
}

test("database startup hydrates no tables and subscriptions load only referenced tables", async () => {
  const visible = hydb.table("subscription_visible", {
    id: id().primaryKey(),
    title: text().notNull(),
  });
  const unrelated = hydb.table("subscription_unrelated", {
    id: id().primaryKey(),
    title: text().notNull(),
  });
  const localSchema = hydb.schema({ visible, unrelated });
  const underlying = await memoryStorage({ schema: localSchema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(visible, { id: "visible", title: "Loaded" }),
      storageMutation.insert(unrelated, {
        id: "unrelated",
        title: "Not loaded",
      }),
    ],
  });
  const operations: string[] = [];
  const db = await hydb.database({
    schema: localSchema,
    storage: recordStorageOperations(underlying, operations),
  });
  const initial = new Promise<void>((resolve) => {
    db.subscribe(hydb.query(visible).many(), (result) => {
      assert.deepEqual(result, [{ id: "visible", title: "Loaded" }]);
      resolve();
    });
  });

  await initial;
  assert.deepEqual(operations, ["snapshot", "snapshot", "table-scan"]);
  await db.close();
});

test("subscriptions replay commits that arrive during snapshot bootstrap exactly once", async () => {
  const counters = hydb.table("bootstrap_race_counters", {
    id: id().primaryKey(),
    value: integer().notNull(),
  });
  const localSchema = hydb.schema({ counters });
  const underlying = await memoryStorage({ schema: localSchema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [storageMutation.insert(counters, { id: "counter", value: 1 })],
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
          announceScan();
          await scanResumed;
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
  const db = await hydb.database({ schema: localSchema, storage });
  const values: number[] = [];
  let announceSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    announceSettled = resolve;
  });
  db.subscribe(
    hydb
      .query(counters)
      .select((counter) => ({ value: counter.value }))
      .require(),
    (result) => {
      values.push(result.value);
      if (values.length === 2) announceSettled();
    },
  );

  await scanStarted;
  await underlying.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(counters, ["counter"], {
        id: "counter",
        value: 2,
      }),
    ],
  });
  await waitForImmediate();
  resumeScan();
  await settled;

  assert.deepEqual(values, [1, 2]);
  await db.close();
});

test("fetch executes a primary-key plan against a current storage snapshot", async () => {
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, {
        id: "task-1",
        title: "Use the planner",
        status: "doing",
        priority: 10,
      }),
    ],
  });
  const operations: string[] = [];
  const db = await hydb.database({
    schema,
    storage: recordStorageOperations(underlying, operations),
  });
  operations.length = 0;

  const result = await db.fetch(
    hydb
      .query(tasks)
      .where((task) => task.id.eq("task-1"))
      .require(),
  );

  assert.deepEqual(result, {
    id: "task-1",
    title: "Use the planner",
    status: "doing",
    priority: 10,
  });
  assert.deepEqual(operations, ["snapshot", "get"]);
  await db.close();
});

test("fetch executes an ordering-only secondary-index plan", async () => {
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, {
        id: "task-1",
        title: "Doing",
        status: "doing",
        priority: 1,
      }),
      storageMutation.insert(tasks, {
        id: "task-2",
        title: "Done",
        status: "done",
        priority: 2,
      }),
      storageMutation.insert(tasks, {
        id: "task-3",
        title: "Also doing",
        status: "doing",
        priority: 3,
      }),
    ],
  });
  const operations: string[] = [];
  const db = await hydb.database({
    schema,
    storage: recordStorageOperations(underlying, operations),
  });
  operations.length = 0;

  const result = await db.fetch(
    hydb
      .query(tasks)
      .orderBy((task) => task.status.asc())
      .select((task) => ({ id: task.id, status: task.status }))
      .many(),
  );

  assert.deepEqual(result, [
    { id: "task-1", status: "doing" },
    { id: "task-3", status: "doing" },
    { id: "task-2", status: "done" },
  ]);
  assert.deepEqual(operations, ["snapshot", "index:tasks_status_priority_idx"]);

  operations.length = 0;
  assert.deepEqual(
    await db.fetch(
      hydb
        .query(tasks)
        .where((task) => task.status.eq("doing"))
        .orderBy((task) => task.priority.desc())
        .select((task) => ({ id: task.id, priority: task.priority }))
        .many(),
    ),
    [
      { id: "task-3", priority: 3 },
      { id: "task-1", priority: 1 },
    ],
  );
  assert.deepEqual(operations, ["snapshot", "index:tasks_status_priority_idx"]);
  await db.close();
});

test("one still detects multiple rows when its scan is bounded", async () => {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, {
        id: "task-1",
        title: "First",
        status: "todo",
        priority: 1,
      }),
      storageMutation.insert(tasks, {
        id: "task-2",
        title: "Second",
        status: "todo",
        priority: 2,
      }),
    ],
  });
  const db = await hydb.database({ schema, storage });

  await assert.rejects(
    db.fetch(hydb.query(tasks).one()),
    /Expected at most one query row/,
  );
  await db.close();
});

test("fetch filters, orders, limits, and projects rows from storage", async () => {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, {
        id: "task-1",
        title: "Low priority",
        status: "todo",
        priority: 1,
      }),
      storageMutation.insert(tasks, {
        id: "task-2",
        title: "Already done",
        status: "done",
        priority: 100,
      }),
      storageMutation.insert(tasks, {
        id: "task-3",
        title: "Highest priority",
        status: "doing",
        priority: 10,
      }),
      storageMutation.insert(tasks, {
        id: "task-4",
        title: "Medium priority",
        status: "todo",
        priority: 5,
      }),
    ],
  });

  const db = await hydb.database({ schema, storage });
  const query = hydb
    .query(tasks)
    .where((task) => task.status.ne("done"))
    .orderBy((task) => [task.priority.desc(), task.id.asc()])
    .limit(2)
    .select((task) => ({
      id: task.id,
      title: task.title,
    }))
    .many();

  assert.deepEqual(await db.fetch(query), [
    { id: "task-3", title: "Highest priority" },
    { id: "task-4", title: "Medium priority" },
  ]);

  await db.close();
});

test("fetch materializes correlated child collections and singular subobjects", async () => {
  const users = hydb.table("nested_users", {
    id: id().primaryKey(),
    name: text().notNull(),
  });
  const projects = hydb.table("nested_projects", {
    id: id().primaryKey(),
    name: text().notNull(),
  });
  const nestedTasks = hydb.table("nested_tasks", {
    id: id().primaryKey(),
    projectId: id()
      .notNull()
      .references(() => projects.id),
    assigneeId: id().references(() => users.id),
    title: text().notNull(),
    priority: integer().notNull(),
  });
  const nestedSchema = hydb.schema({ users, projects, nestedTasks });
  const storage = await memoryStorage({ schema: nestedSchema });

  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(users, { id: "user-1", name: "Sam" }),
      storageMutation.insert(projects, { id: "project-1", name: "HyDB" }),
      storageMutation.insert(nestedTasks, {
        id: "task-1",
        projectId: "project-1",
        assigneeId: "user-1",
        title: "Build query engine",
        priority: 10,
      }),
      storageMutation.insert(nestedTasks, {
        id: "task-2",
        projectId: "project-1",
        assigneeId: null,
        title: "Write documentation",
        priority: 2,
      }),
    ],
  });

  const db = await hydb.database({ schema: nestedSchema, storage });
  const query = hydb
    .query(projects)
    .where((project) => project.id.eq("project-1"))
    .select((project) => ({
      id: project.id,
      name: project.name,
      tasks: hydb
        .query(nestedTasks)
        .where((task) => task.projectId.eq(project.id))
        .orderBy((task) => task.priority.desc())
        .select((task) => ({
          id: task.id,
          title: task.title,
          assignee: hydb
            .query(users)
            .where((user) => task.assigneeId.eq(user.id))
            .select((user) => ({ id: user.id, name: user.name }))
            .one(),
        }))
        .many(),
      taskCount: hydb
        .query(nestedTasks)
        .where((task) => task.projectId.eq(project.id))
        .count(),
      hasTasks: hydb
        .query(nestedTasks)
        .where((task) => task.projectId.eq(project.id))
        .exists(),
    }))
    .one();

  assert.deepEqual(await db.fetch(query), {
    id: "project-1",
    name: "HyDB",
    tasks: [
      {
        id: "task-1",
        title: "Build query engine",
        assignee: { id: "user-1", name: "Sam" },
      },
      {
        id: "task-2",
        title: "Write documentation",
        assignee: null,
      },
    ],
    taskCount: 2,
    hasTasks: true,
  });

  await db.close();
});

test("subscribe publishes one settled nested result for each relevant commit", async () => {
  const projects = hydb.table("live_projects", {
    id: id().primaryKey(),
    name: text().notNull(),
  });
  const liveTasks = hydb.table("live_tasks", {
    id: id().primaryKey(),
    projectId: id()
      .notNull()
      .references(() => projects.id),
    title: text().notNull(),
    priority: integer().notNull(),
  });
  const liveSchema = hydb.schema({ projects, liveTasks });
  const storage = await memoryStorage({ schema: liveSchema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(projects, { id: "project-1", name: "HyDB" }),
      storageMutation.insert(liveTasks, {
        id: "task-1",
        projectId: "project-1",
        title: "First task",
        priority: 1,
      }),
    ],
  });

  const db = await hydb.database({ schema: liveSchema, storage });
  const query = hydb
    .query(projects)
    .where((project) => project.id.eq("project-1"))
    .select((project) => ({
      id: project.id,
      tasks: hydb
        .query(liveTasks)
        .where((task) => task.projectId.eq(project.id))
        .orderBy((task) => task.priority.desc())
        .select((task) => ({ id: task.id, title: task.title }))
        .many(),
    }))
    .require();

  const results: Array<Awaited<ReturnType<typeof db.fetch<typeof query>>>> = [];
  let resolveUpdate!: () => void;
  const updated = new Promise<void>((resolve) => {
    resolveUpdate = resolve;
  });
  const unsubscribe = db.subscribe(query, (result) => {
    results.push(result);
    if (results.length === 2) resolveUpdate();
  });

  await storage.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(liveTasks, ["task-1"], {
        id: "task-1",
        projectId: "project-1",
        title: "Updated first task",
        priority: 1,
      }),
      storageMutation.insert(liveTasks, {
        id: "task-2",
        projectId: "project-1",
        title: "Higher priority task",
        priority: 10,
      }),
    ],
  });

  await updated;

  assert.deepEqual(results, [
    {
      id: "project-1",
      tasks: [{ id: "task-1", title: "First task" }],
    },
    {
      id: "project-1",
      tasks: [
        { id: "task-2", title: "Higher priority task" },
        { id: "task-1", title: "Updated first task" },
      ],
    },
  ]);

  unsubscribe();
  await db.close();
});
