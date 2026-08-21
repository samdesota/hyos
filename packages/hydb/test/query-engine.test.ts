import assert from "node:assert/strict";
import test from "node:test";

import {
  hydb,
  id,
  integer,
  memoryStorage,
  storageMutation,
  text,
} from "../src/index.js";

const taskStatus = hydb.enum("task_status", ["todo", "doing", "done"]);

const tasks = hydb.table("tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
  status: taskStatus().notNull(),
  priority: integer().notNull(),
});

const schema = hydb.schema({ tasks });

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
