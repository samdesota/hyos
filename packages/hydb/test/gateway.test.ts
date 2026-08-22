import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  hydb,
  id,
  memoryStorage,
  storageMutation,
  text,
} from "../src/index.js";

const tasks = hydb.table("gateway_tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const schema = hydb.schema({ tasks });

async function setup() {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, { id: "first", title: "Existing" }),
    ],
  });
  const database = await hydb.database({ schema, storage });
  const renameTask = hydb.command({
    input: z.object({ id: z.string(), title: z.string() }),
    handler: async (transaction, input) => {
      return transaction.update(tasks, [input.id], { title: input.title });
    },
  });
  const principal = z.object({ userId: z.string() });
  const policies = hydb.readPolicy(principal);
  const gateway = hydb.gateway({
    database,
    principal,
    commands: { renameTask },
    readPolicies: [policies.allowAll(tasks)],
  });
  return { database, gateway };
}

test("a principal-bound gateway session fetches through read policies", async () => {
  const { database, gateway } = await setup();
  try {
    const session = gateway.forPrincipal({ userId: "alice" });

    assert.deepEqual(await session.fetch(hydb.query(tasks).many()), [
      { id: "first", title: "Existing" },
    ]);
  } finally {
    await database.close();
  }
});

test("gateway subscriptions use the same principal-bound read path", async () => {
  const { database, gateway } = await setup();
  try {
    const session = gateway.forPrincipal({ userId: "alice" });
    const initial = new Promise<readonly { id: string; title: string }[]>(
      (resolve) => {
        const unsubscribe = session.subscribe(
          hydb.query(tasks).many(),
          (result) => {
            unsubscribe();
            resolve(result);
          },
        );
      },
    );

    assert.deepEqual(await initial, [{ id: "first", title: "Existing" }]);
  } finally {
    await database.close();
  }
});

test("gateway sessions execute only registered commands by name", async () => {
  const { database, gateway } = await setup();
  try {
    const session = gateway.forPrincipal({ userId: "alice" });

    assert.deepEqual(
      await session.execute("renameTask", {
        id: "first",
        title: "Renamed",
      }),
      { id: "first", title: "Renamed" },
    );
    await assert.rejects(
      session.execute("missing" as "renameTask", {
        id: "first",
        title: "Ignored",
      }),
      /Unknown gateway command: missing/,
    );
  } finally {
    await database.close();
  }
});

test("gateway sessions validate principal context before any operation", async () => {
  const { database, gateway } = await setup();
  try {
    assert.throws(
      () => gateway.forPrincipal({ userId: 42 } as never),
      z.ZodError,
    );
  } finally {
    await database.close();
  }
});
