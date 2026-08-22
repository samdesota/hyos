import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { hydb, id, memoryStorage, storageMutation, text } from "@hyos/hydb";
import { hyapp } from "../src/index.js";

const principal = z.object({ userId: z.string() });
const tasks = hydb.table("hyapp_gateway_tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const schema = hydb.schema({ tasks });

async function setup() {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [storageMutation.insert(tasks, { id: "task", title: "Before" })],
  });
  const database = await hydb.database({ schema, storage });
  const writes = hydb.writePolicy(principal);
  const commands = hyapp.commandFactory({
    principal,
    defaultPolicy: [writes.allowAll(tasks)],
  });
  const renameTask = commands.define({
    input: z.object({ id: z.string(), title: z.string() }),
    output: z.object({ id: z.string() }),
    async optimistic({ transaction }, input) {
      await transaction.update(tasks, [input.id], { title: input.title });
    },
    async server({ applyOptimistic }, input) {
      await applyOptimistic();
      return { id: input.id };
    },
  });
  const reads = hydb.readPolicy(principal);
  const gateway = hyapp.gateway({
    database,
    principal,
    registry: hyapp.commandRegistry({ renameTask }),
    readPolicies: [reads.allowAll(tasks)],
  });
  return { database, gateway };
}

test("a hyapp gateway enforces reads and dispatches new commands", async () => {
  const { database, gateway } = await setup();
  try {
    const session = gateway.forPrincipal({ userId: "alice" });
    assert.deepEqual(await session.fetch(hydb.query(tasks).many()), [
      { id: "task", title: "Before" },
    ]);
    assert.deepEqual(
      await session.execute("renameTask", { id: "task", title: "After" }),
      { id: "task" },
    );
    assert.deepEqual(await session.fetch(hydb.query(tasks).many()), [
      { id: "task", title: "After" },
    ]);
    await assert.rejects(
      session.execute("missing" as "renameTask", {
        id: "task",
        title: "Ignored",
      }),
      /Unknown gateway command: missing/,
    );
  } finally {
    await database.close();
  }
});

test("gateways reject commands from another principal-schema instance", async () => {
  const storage = await memoryStorage({ schema });
  const database = await hydb.database({ schema, storage });
  const otherPrincipal = z.object({ userId: z.string() });
  const writes = hydb.writePolicy(otherPrincipal);
  const commands = hyapp.commandFactory({
    principal: otherPrincipal,
    defaultPolicy: [writes.allowAll(tasks)],
  });
  const command = commands.define({
    input: z.undefined(),
    output: z.undefined(),
    async server() {},
  });
  const reads = hydb.readPolicy(principal);

  try {
    assert.throws(
      () =>
        hyapp.gateway({
          database,
          principal,
          registry: hyapp.commandRegistry({ command }),
          readPolicies: [reads.allowAll(tasks)],
        }),
      /principal schema/,
    );
  } finally {
    await database.close();
  }
});
