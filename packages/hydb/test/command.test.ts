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
  type Transaction,
} from "../src/index.js";

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
    handler: (tx, input) => {
      tx.insert(projects, { id: input.projectId, name: input.name });
      tx.insert(tasks, {
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
    handler: (tx, input) => {
      handlerCalls += 1;
      tx.insert(tasks, input);
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
      observedValues.push(tx.get(counters, ["counter"])?.value ?? -1);
      started();
      await paused;
      observedValues.push(tx.get(counters, ["counter"])?.value ?? -1);
      tx.update(counters, ["counter"], { value: 1 });
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
    handler: (tx, input) => {
      tx.insert(tasks, { id: "kept", title: input.title });
      assert.deepEqual(tx.get(tasks, ["kept"]), {
        id: "kept",
        title: input.title,
        status: "todo",
        note: null,
      });
      const updated = tx.update(tasks, ["kept"], { title: "Updated" });
      tx.insert(tasks, { id: "discarded", title: "Temporary" });
      tx.delete(tasks, ["discarded"]);
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
    handler: (tx) => {
      tx.update(tasks, ["kept"], { status: "done" });
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
    handler: (tx) => {
      tx.insert(tasks, { id: "duplicate", title: "First" });
      tx.insert(tasks, { id: "duplicate", title: "Second" });
    },
  });
  await assert.rejects(
    db.execute(duplicate, undefined),
    /Duplicate primary key/,
  );

  const missingInsertColumn = hydb.command({
    input: z.undefined(),
    handler: (tx) => {
      tx.insert(tasks, { id: "missing" } as never);
    },
  });
  await assert.rejects(
    db.execute(missingInsertColumn, undefined),
    /Missing required column command_guard_tasks.title/,
  );

  const missingRows = hydb.command({
    input: z.enum(["update", "delete"]),
    handler: (tx, operation) => {
      if (operation === "update") {
        tx.update(tasks, ["missing"], { title: "No row" });
      } else tx.delete(tasks, ["missing"]);
    },
  });
  await assert.rejects(db.execute(missingRows, "update"), /Missing row/);
  await assert.rejects(db.execute(missingRows, "delete"), /Missing row/);

  const invalidUpdate = hydb.command({
    input: z.record(z.string(), z.unknown()),
    handler: (tx, changes) => {
      tx.insert(tasks, { id: "task", title: "Valid" });
      tx.update(tasks, ["task"], changes as never);
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
    handler: (tx) => {
      tx.get(outsideSchema, ["missing"]);
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
  assert.throws(() => escaped.get(tasks, ["task"]), /no longer active/);

  assert.deepEqual(await db.fetch(hydb.query(tasks).many()), []);
  await db.close();
});
