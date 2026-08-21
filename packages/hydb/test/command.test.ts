import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { setImmediate as waitForImmediate } from "node:timers/promises";

import {
  hydb,
  id,
  integer,
  memoryStorage,
  StorageConflictError,
  storageMutation,
  text,
  type StorageDatabase,
  type StorageSnapshot,
  type Transaction,
} from "../src/index.js";

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
          operations.push("scan");
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

test("commands read through a storage snapshot and preserve read-your-writes", async () => {
  const counters = hydb.table("snapshot_command_counters", {
    id: id().primaryKey(),
    value: integer().notNull(),
  });
  const schema = hydb.schema({ counters });
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [storageMutation.insert(counters, { id: "counter", value: 1 })],
  });
  const operations: string[] = [];
  const db = await hydb.database({
    schema,
    storage: recordStorageOperations(underlying, operations),
  });
  operations.length = 0;

  const increment = hydb.command({
    input: z.undefined(),
    handler: async (tx) => {
      const before = await tx.get(counters, ["counter"]);
      const updated = await tx.update(counters, ["counter"], {
        value: (before?.value ?? 0) + 1,
      });
      const after = await tx.get(counters, ["counter"]);
      return { updated, after };
    },
  });

  assert.deepEqual(await db.execute(increment, undefined), {
    updated: { id: "counter", value: 2 },
    after: { id: "counter", value: 2 },
  });
  assert.deepEqual(operations, ["snapshot", "get"]);
  await db.close();
});

test("command commits settle through the ordered durable change stream", async () => {
  const counters = hydb.table("ordered_command_counters", {
    id: id().primaryKey(),
    value: integer().notNull(),
  });
  const schema = hydb.schema({ counters });
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [storageMutation.insert(counters, { id: "counter", value: 0 })],
  });
  let releaseChanges!: () => void;
  const changesReleased = new Promise<void>((resolve) => {
    releaseChanges = resolve;
  });
  let announceCommandCommit!: () => void;
  const commandCommitted = new Promise<void>((resolve) => {
    announceCommandCommit = resolve;
  });
  const storage: StorageDatabase = {
    snapshot: (selector) => underlying.snapshot(selector),
    head: (branch) => underlying.head(branch),
    createBranch: (request) => underlying.createBranch(request),
    async commit(request) {
      const commit = await underlying.commit(request);
      announceCommandCommit();
      return commit;
    },
    async *changes(options) {
      await changesReleased;
      yield* underlying.changes(options);
    },
    retain: (request) => underlying.retain(request),
    releaseRetention: (name) => underlying.releaseRetention(name),
    collectGarbage: () => underlying.collectGarbage(),
    close: () => underlying.close(),
  };
  const db = await hydb.database({ schema, storage });
  const values: number[] = [];
  let announceInitial!: () => void;
  const initialized = new Promise<void>((resolve) => {
    announceInitial = resolve;
  });
  db.subscribe(
    hydb
      .query(counters)
      .select((counter) => ({ value: counter.value }))
      .require(),
    (result) => {
      values.push(result.value);
      if (values.length === 1) announceInitial();
    },
  );
  await initialized;
  await underlying.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(counters, ["counter"], {
        id: "counter",
        value: 1,
      }),
    ],
  });
  const setTwo = hydb.command({
    input: z.undefined(),
    handler: async (tx) => {
      await tx.update(counters, ["counter"], { value: 2 });
    },
  });

  const execution = db.execute(setTwo, undefined);
  await commandCommitted;
  releaseChanges();
  await execution;
  await waitForImmediate();

  assert.deepEqual(values, [0, 1, 2]);
  await db.close();
});

test("a command atomically publishes its transaction and returns its result", async () => {
  const projects = hydb.table("command_projects", {
    id: id().primaryKey(),
    name: text().notNull(),
  });
  const tasks = hydb.table("command_tasks", {
    id: id().primaryKey(),
    projectId: id().notNull(),
    title: text().notNull(),
  });
  const schema = hydb.schema({ projects, tasks });
  const storage = await memoryStorage({ schema });
  const db = await hydb.database({ schema, storage });
  const projectList = hydb
    .query(projects)
    .select((project) => ({
      id: project.id,
      name: project.name,
      tasks: hydb
        .query(tasks)
        .where((task) => task.projectId.eq(project.id))
        .select((task) => ({ id: task.id, title: task.title }))
        .many(),
    }))
    .many();
  const results: Array<
    Awaited<ReturnType<typeof db.fetch<typeof projectList>>>
  > = [];
  db.subscribe(projectList, (result) => results.push(result));

  const createProject = hydb.command({
    input: z.object({
      projectId: z.string().min(1),
      name: z.string().trim().min(1),
      firstTask: z.string().trim().min(1),
    }),
    handler: async (tx, input) => {
      await tx.insert(projects, { id: input.projectId, name: input.name });
      await tx.insert(tasks, {
        id: `${input.projectId}-first-task`,
        projectId: input.projectId,
        title: input.firstTask,
      });
      return { createdProjectId: input.projectId };
    },
  });

  const result = await db.execute(createProject, {
    projectId: "hydb",
    name: "  HyDB  ",
    firstTask: "  Build commands  ",
  });

  assert.deepEqual(result, { createdProjectId: "hydb" });
  assert.deepEqual(results, [
    [],
    [
      {
        id: "hydb",
        name: "HyDB",
        tasks: [{ id: "hydb-first-task", title: "Build commands" }],
      },
    ],
  ]);
  await db.close();
});

test("invalid command input is rejected before the handler runs", async () => {
  const tasks = hydb.table("validated_command_tasks", {
    id: id().primaryKey(),
    title: text().notNull(),
  });
  const schema = hydb.schema({ tasks });
  const storage = await memoryStorage({ schema });
  const db = await hydb.database({ schema, storage });
  let handlerCalls = 0;
  const createTask = hydb.command({
    input: z.object({
      id: z.string().uuid(),
      title: z.string().trim().min(3),
    }),
    handler: async (tx, input) => {
      handlerCalls += 1;
      await tx.insert(tasks, input);
    },
  });

  await assert.rejects(
    db.execute(createTask, { id: "not-a-uuid", title: " x " }),
    z.ZodError,
  );
  assert.equal(handlerCalls, 0);
  assert.deepEqual(await db.fetch(hydb.query(tasks).many()), []);
  const snapshot = await storage.snapshot();
  assert.equal(snapshot.version, 0);
  await snapshot.close();
  await db.close();
});

test("a conflicting command keeps its snapshot and is never rerun", async () => {
  const counters = hydb.table("command_conflict_counters", {
    id: id().primaryKey(),
    value: integer().notNull(),
  });
  const schema = hydb.schema({ counters });
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [storageMutation.insert(counters, { id: "counter", value: 0 })],
  });
  const db = await hydb.database({ schema, storage });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let started!: () => void;
  const commandStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let handlerCalls = 0;
  const observedValues: number[] = [];
  const increment = hydb.command({
    input: z.undefined(),
    handler: async (tx) => {
      handlerCalls += 1;
      observedValues.push((await tx.get(counters, ["counter"]))?.value ?? -1);
      started();
      await paused;
      observedValues.push((await tx.get(counters, ["counter"]))?.value ?? -1);
      await tx.update(counters, ["counter"], { value: 1 });
    },
  });

  const execution = db.execute(increment, undefined);
  await commandStarted;
  await storage.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(counters, ["counter"], {
        id: "counter",
        value: 10,
      }),
    ],
  });
  await waitForImmediate();
  resume();

  await assert.rejects(execution, StorageConflictError);
  assert.equal(handlerCalls, 1);
  assert.deepEqual(observedValues, [0, 0]);
  assert.deepEqual(await db.fetch(hydb.query(counters).require()), {
    id: "counter",
    value: 10,
  });
  await db.close();
});

test("commands apply defaults, expose read-your-writes, and discard failed work", async () => {
  const taskStatus = hydb.enum("command_task_status", ["todo", "done"]);
  const tasks = hydb.table("command_default_tasks", {
    id: id().primaryKey(),
    title: text().notNull(),
    status: taskStatus().notNull().default("todo"),
    note: text(),
  });
  const schema = hydb.schema({ tasks });
  const storage = await memoryStorage({ schema });
  const db = await hydb.database({ schema, storage });
  const taskList = hydb.query(tasks).many();
  const published: Array<
    Awaited<ReturnType<typeof db.fetch<typeof taskList>>>
  > = [];
  db.subscribe(taskList, (result) => published.push(result));

  const prepareTask = hydb.command({
    input: z.object({ title: z.string() }),
    handler: async (tx, input) => {
      await tx.insert(tasks, { id: "kept", title: input.title });
      assert.deepEqual(await tx.get(tasks, ["kept"]), {
        id: "kept",
        title: input.title,
        status: "todo",
        note: null,
      });
      const updated = await tx.update(tasks, ["kept"], { title: "Updated" });
      await tx.insert(tasks, { id: "discarded", title: "Temporary" });
      await tx.delete(tasks, ["discarded"]);
      return updated;
    },
  });

  assert.deepEqual(await db.execute(prepareTask, { title: "Initial" }), {
    id: "kept",
    title: "Updated",
    status: "todo",
    note: null,
  });
  assert.deepEqual(published, [
    [],
    [{ id: "kept", title: "Updated", status: "todo", note: null }],
  ]);

  const failAfterWriting = hydb.command({
    input: z.undefined(),
    handler: async (tx) => {
      await tx.update(tasks, ["kept"], { status: "done" });
      throw new Error("command failed");
    },
  });
  await assert.rejects(
    db.execute(failAfterWriting, undefined),
    /command failed/,
  );
  assert.deepEqual(await db.fetch(taskList), [
    { id: "kept", title: "Updated", status: "todo", note: null },
  ]);
  assert.equal(published.length, 2);
  await db.close();
});

test("transactions reject invalid writes and cannot escape their command", async () => {
  const tasks = hydb.table("command_guard_tasks", {
    id: id().primaryKey(),
    title: text().notNull(),
  });
  const outsideSchema = hydb.table("command_outside_tasks", {
    id: id().primaryKey(),
  });
  const schema = hydb.schema({ tasks });
  const storage = await memoryStorage({ schema });
  const db = await hydb.database({ schema, storage });

  const duplicate = hydb.command({
    input: z.undefined(),
    handler: async (tx) => {
      await tx.insert(tasks, { id: "duplicate", title: "First" });
      await tx.insert(tasks, { id: "duplicate", title: "Second" });
    },
  });
  await assert.rejects(
    db.execute(duplicate, undefined),
    /Duplicate primary key/,
  );

  const missingInsertColumn = hydb.command({
    input: z.undefined(),
    handler: async (tx) => {
      await tx.insert(tasks, { id: "missing" } as never);
    },
  });
  await assert.rejects(
    db.execute(missingInsertColumn, undefined),
    /Missing required column command_guard_tasks.title/,
  );

  const missingRows = hydb.command({
    input: z.enum(["update", "delete"]),
    handler: async (tx, operation) => {
      if (operation === "update") {
        await tx.update(tasks, ["missing"], { title: "No row" });
      } else await tx.delete(tasks, ["missing"]);
    },
  });
  await assert.rejects(db.execute(missingRows, "update"), /Missing row/);
  await assert.rejects(db.execute(missingRows, "delete"), /Missing row/);

  const invalidUpdate = hydb.command({
    input: z.record(z.string(), z.unknown()),
    handler: async (tx, changes) => {
      await tx.insert(tasks, { id: "task", title: "Valid" });
      await tx.update(tasks, ["task"], changes as never);
    },
  });
  await assert.rejects(
    db.execute(invalidUpdate, { missing: true }),
    /Unknown column command_guard_tasks.missing/,
  );
  await assert.rejects(
    db.execute(invalidUpdate, { id: "replacement" }),
    /Primary keys cannot be updated/,
  );

  const unknownTable = hydb.command({
    input: z.undefined(),
    handler: async (tx) => {
      await tx.get(outsideSchema, ["missing"]);
    },
  });
  await assert.rejects(db.execute(unknownTable, undefined), /Unknown table/);

  let escaped!: Transaction;
  const capture = hydb.command({
    input: z.undefined(),
    handler: (tx) => {
      escaped = tx;
    },
  });
  await db.execute(capture, undefined);
  await assert.rejects(escaped.get(tasks, ["task"]), /no longer active/);

  assert.deepEqual(await db.fetch(hydb.query(tasks).many()), []);
  await db.close();
});
