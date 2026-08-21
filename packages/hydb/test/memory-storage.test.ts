import assert from "node:assert/strict";
import test from "node:test";

import {
  hydb,
  id,
  memoryStorage,
  StorageConflictError,
  storageMutation,
  text,
  index,
  uniqueIndex,
} from "../src/index.js";

const tasks = hydb.table("tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
});

const schema = hydb.schema({ tasks });

test("a committed insert is visible in new snapshots but not old snapshots", async () => {
  const storage = await memoryStorage({ schema });
  const before = await storage.snapshot();

  const commit = await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, {
        id: "task-1",
        title: "Build storage",
      }),
    ],
  });

  const after = await storage.snapshot();

  assert.equal(commit.version, 1);
  assert.equal(await before.get(tasks, ["task-1"]), undefined);
  assert.deepEqual(await after.get(tasks, ["task-1"]), {
    id: "task-1",
    title: "Build storage",
  });

  await before.close();
  await after.close();
  await storage.close();
});

test("updates and deletes commit atomically with authoritative before and after rows", async () => {
  const storage = await memoryStorage({ schema });

  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, {
        id: "task-1",
        title: "First title",
      }),
      storageMutation.insert(tasks, {
        id: "task-2",
        title: "Delete me",
      }),
    ],
  });

  const commit = await storage.commit({
    expectedVersion: 1,
    mutations: [
      storageMutation.update(tasks, ["task-1"], {
        id: "task-1",
        title: "Updated title",
      }),
      storageMutation.delete(tasks, ["task-2"]),
    ],
  });

  assert.deepEqual(commit.changes, [
    {
      table: tasks,
      key: ["task-1"],
      before: { id: "task-1", title: "First title" },
      after: { id: "task-1", title: "Updated title" },
    },
    {
      table: tasks,
      key: ["task-2"],
      before: { id: "task-2", title: "Delete me" },
    },
  ]);

  const snapshot = await storage.snapshot();
  assert.deepEqual(await snapshot.get(tasks, ["task-1"]), {
    id: "task-1",
    title: "Updated title",
  });
  assert.equal(await snapshot.get(tasks, ["task-2"]), undefined);

  await snapshot.close();
  await storage.close();
});

test("table scans stream rows from one consistent snapshot", async () => {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, { id: "task-1", title: "First" }),
      storageMutation.insert(tasks, { id: "task-2", title: "Second" }),
    ],
  });

  const snapshot = await storage.snapshot();
  const rows = [];
  for await (const batch of snapshot.scan({ type: "table", table: tasks })) {
    rows.push(...batch);
  }

  assert.deepEqual(rows, [
    { id: "task-1", title: "First" },
    { id: "task-2", title: "Second" },
  ]);

  await snapshot.close();
  await storage.close();
});

test("declared indexes support equality scans and enforce uniqueness atomically", async () => {
  const indexedTasks = hydb.table(
    "indexed_tasks",
    {
      id: id().primaryKey(),
      projectId: id().notNull(),
      externalId: text().notNull(),
      title: text().notNull(),
    },
    (task) => [
      index("indexed_tasks_project_idx").on(task.projectId),
      uniqueIndex("indexed_tasks_external_id_unique").on(task.externalId),
    ],
  );
  const indexedSchema = hydb.schema({ indexedTasks });
  const storage = await memoryStorage({ schema: indexedSchema });

  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(indexedTasks, {
        id: "task-1",
        projectId: "project-1",
        externalId: "external-1",
        title: "First",
      }),
      storageMutation.insert(indexedTasks, {
        id: "task-2",
        projectId: "project-1",
        externalId: "external-2",
        title: "Second",
      }),
      storageMutation.insert(indexedTasks, {
        id: "task-3",
        projectId: "project-2",
        externalId: "external-3",
        title: "Third",
      }),
    ],
  });

  const snapshot = await storage.snapshot();
  const rows = [];
  for await (const batch of snapshot.scan({
    type: "index",
    table: indexedTasks,
    index: "indexed_tasks_project_idx",
    key: ["project-1"],
  })) {
    rows.push(...batch);
  }

  assert.deepEqual(rows, [
    {
      id: "task-1",
      projectId: "project-1",
      externalId: "external-1",
      title: "First",
    },
    {
      id: "task-2",
      projectId: "project-1",
      externalId: "external-2",
      title: "Second",
    },
  ]);

  await assert.rejects(
    storage.commit({
      expectedVersion: 1,
      mutations: [
        storageMutation.insert(indexedTasks, {
          id: "task-4",
          projectId: "project-1",
          externalId: "external-4",
          title: "Would otherwise succeed",
        }),
        storageMutation.insert(indexedTasks, {
          id: "task-5",
          projectId: "project-2",
          externalId: "external-1",
          title: "Duplicate external ID",
        }),
      ],
    }),
    /Unique index indexed_tasks_external_id_unique rejected a duplicate key/,
  );

  const unchanged = await storage.snapshot();
  assert.equal(unchanged.version, 1);
  assert.equal(await unchanged.get(indexedTasks, ["task-4"]), undefined);

  await snapshot.close();
  await unchanged.close();
  await storage.close();
});

test("a stale expected version cannot overwrite a newer commit", async () => {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, { id: "task-1", title: "Committed" }),
    ],
  });

  await assert.rejects(
    storage.commit({
      expectedVersion: 0,
      mutations: [
        storageMutation.insert(tasks, { id: "task-2", title: "Stale" }),
      ],
    }),
    (error: unknown) =>
      error instanceof StorageConflictError &&
      error.expectedVersion === 0 &&
      error.actualVersion === 1,
  );

  await storage.close();
});
