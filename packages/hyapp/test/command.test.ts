import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { hydb, id, memoryStorage, storageMutation, text } from "@hyos/hydb";
import {
  createClientCommandFactory,
  createCommandContract,
  executeOptimisticCommand,
  executeServerCommand,
  hyapp,
  type MutationTransaction,
} from "../src/index.js";

const principal = z.object({ userId: z.string() });
const projects = hydb.table("hyapp_command_projects", {
  id: id().primaryKey(),
  ownerId: id().notNull(),
});
const tasks = hydb.table("hyapp_command_tasks", {
  id: id().primaryKey(),
  projectId: id().notNull(),
  title: text().notNull(),
});
const schema = hydb.schema({ projects, tasks });

async function setup() {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(projects, {
        id: "project",
        ownerId: "alice",
      }),
      storageMutation.insert(tasks, {
        id: "task",
        projectId: "project",
        title: "Before",
      }),
    ],
  });
  return hydb.database({ schema, storage });
}

test("a command factory shares principal and policy configuration", async () => {
  const database = await setup();
  const writes = hydb.writePolicy(principal);
  const commands = hyapp.commandFactory({
    principal,
    defaultPolicy: [writes.allowAll(projects), writes.allowAll(tasks)],
  });
  let optimisticFinished = false;
  const renameTask = commands.define({
    input: z.object({
      id: z.string(),
      title: z.string().transform((title) => title.trim()),
    }),
    output: z.object({ id: z.string(), actor: z.string() }),
    async optimistic({ transaction }, input) {
      await Promise.resolve();
      await transaction.update(tasks, [input.id], { title: input.title });
      optimisticFinished = true;
    },
    async server({ applyOptimistic, principal: actor }, input) {
      await applyOptimistic();
      assert.equal(optimisticFinished, true);
      return { id: input.id, actor: actor.userId };
    },
  });

  try {
    assert.deepEqual(
      await executeServerCommand(
        database,
        renameTask,
        { id: "task", title: "  After  " },
        { userId: "alice" },
      ),
      { id: "task", actor: "alice" },
    );
    assert.deepEqual(await database.fetch(hydb.query(tasks).many()), [
      { id: "task", projectId: "project", title: "After" },
    ]);
  } finally {
    await database.close();
  }
});

test("server output validation and duplicate optimistic application abort", async () => {
  const database = await setup();
  const writes = hydb.writePolicy(principal);
  const commands = hyapp.commandFactory({
    principal,
    defaultPolicy: [writes.allowAll(projects), writes.allowAll(tasks)],
  });
  const invalidOutput = commands.define({
    input: z.undefined(),
    output: z.object({ ok: z.literal(true) }),
    async server({ transaction }) {
      await transaction.update(tasks, ["task"], { title: "Not committed" });
      return { ok: false } as never;
    },
  });
  const duplicateOptimism = commands.define({
    input: z.undefined(),
    output: z.undefined(),
    async optimistic({ transaction }) {
      await transaction.update(tasks, ["task"], { title: "Also aborted" });
    },
    async server({ applyOptimistic }) {
      await applyOptimistic();
      await applyOptimistic();
    },
  });

  try {
    await assert.rejects(
      executeServerCommand(database, invalidOutput, undefined, {
        userId: "alice",
      }),
      z.ZodError,
    );
    await assert.rejects(
      executeServerCommand(database, duplicateOptimism, undefined, {
        userId: "alice",
      }),
      /may only be applied once/,
    );
    assert.equal(
      (await database.fetch(hydb.query(tasks).require())).title,
      "Before",
    );
  } finally {
    await database.close();
  }
});

test("commands can prove exceptional writes with async admin reads", async () => {
  const database = await setup();
  const writes = hydb.writePolicy(principal);
  const commands = hyapp.commandFactory({
    principal,
    defaultPolicy: [writes.allowAll(projects), writes.denyAll(tasks)],
  });
  const renameTask = commands.define({
    input: z.object({ taskId: z.string(), projectId: z.string() }),
    output: z.undefined(),
    async optimistic({ transaction }, input) {
      await transaction.update(tasks, [input.taskId], { title: "Admin" });
    },
    async server({ transaction, applyOptimistic, principal: actor }, input) {
      await transaction.withAdminPolicy(async ({ db, assert: authorize }) => {
        const project = await db.get(projects, [input.projectId]);
        authorize(
          project?.ownerId === actor.userId,
          "Only the project owner may update tasks",
        );
        await applyOptimistic();
      });
    },
  });

  try {
    await assert.rejects(
      executeServerCommand(
        database,
        renameTask,
        { taskId: "task", projectId: "project" },
        { userId: "bob" },
      ),
      /Only the project owner may update tasks/,
    );
    await executeServerCommand(
      database,
      renameTask,
      { taskId: "task", projectId: "project" },
      { userId: "alice" },
    );
    assert.equal(
      (await database.fetch(hydb.query(tasks).require())).title,
      "Admin",
    );
  } finally {
    await database.close();
  }
});

test("the explicit client factory executes only optimistic behavior", async () => {
  const updates: unknown[] = [];
  const contract = createCommandContract({
    input: z.object({
      id: z.string(),
      title: z.string().transform((title) => title.trim()),
    }),
    output: z.object({ id: z.string() }),
  });
  const commands = createClientCommandFactory();
  const renameTask = commands.define({
    contract,
    async optimistic({ transaction }, input) {
      await transaction.update(tasks, [input.id], { title: input.title });
    },
  });
  const transaction = {
    async insert() {
      throw new Error("unused");
    },
    async update(table: unknown, key: unknown, changes: unknown) {
      updates.push({ table, key, changes });
      return {};
    },
    async delete() {
      throw new Error("unused");
    },
  } as MutationTransaction;

  await executeOptimisticCommand(
    renameTask,
    { id: "task", title: "  Client  " },
    transaction,
  );

  assert.deepEqual(updates, [
    { table: tasks, key: ["task"], changes: { title: "Client" } },
  ]);
});

test("command factories reject policies from another principal schema", () => {
  const otherPrincipal = z.object({ userId: z.string() });
  const otherWrites = hydb.writePolicy(otherPrincipal);

  assert.throws(
    () =>
      hyapp.commandFactory({
        principal,
        defaultPolicy: [otherWrites.allowAll(tasks)],
      } as never),
    /factory's principal schema/,
  );
});
