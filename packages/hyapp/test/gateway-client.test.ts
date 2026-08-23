import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { hydb, id, memoryStorage, storageMutation, text } from "@hyos/hydb";
import {
  createClientCommandFactory,
  directGatewayTransport,
  gatewayClient,
  hyapp,
  type GatewayClientTransport,
  type MutationTransaction,
  type OptimisticLayer,
} from "../src/index.js";

const principal = z.object({ userId: z.string() });
const tasks = hydb.table("gateway_client_tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const schema = hydb.schema({ tasks });
const renameInput = z.object({ id: z.string(), title: z.string().trim() });
const renameOutput = z.object({ id: z.string(), title: z.string() });

async function setup() {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [storageMutation.insert(tasks, { id: "task", title: "Before" })],
  });
  const database = await hydb.database({ schema, storage });
  const writes = hydb.writePolicy(principal);
  const serverCommands = hyapp.commandFactory({
    principal,
    defaultPolicy: [writes.allowAll(tasks)],
  });
  const serverRenameTask = serverCommands.define({
    input: renameInput,
    output: renameOutput,
    async optimistic({ transaction }, input) {
      await transaction.update(tasks, [input.id], { title: input.title });
    },
    async server({ applyOptimistic }, input) {
      await applyOptimistic();
      return { id: input.id, title: input.title };
    },
  });
  const serverRegistry = hyapp.commandRegistry({
    renameTask: serverRenameTask,
  });
  const reads = hydb.readPolicy(principal);
  const gateway = hyapp.gateway({
    database,
    principal,
    registry: serverRegistry,
    readPolicies: [reads.allowAll(tasks)],
  });

  const clientCommands = createClientCommandFactory();
  const clientRenameTask = clientCommands.define({
    input: renameInput,
    output: renameOutput,
    async optimistic({ transaction }, input) {
      await transaction.update(tasks, [input.id], { title: input.title });
    },
  });
  const clientRegistry = hyapp.commandRegistry({
    renameTask: clientRenameTask,
  });

  return { database, gateway, clientRegistry, serverRegistry };
}

function recordingTransaction(updates: unknown[]): MutationTransaction {
  return {
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
}

test("a gateway client dispatches a typed registry through a direct transport", async () => {
  const { database, gateway, clientRegistry } = await setup();
  const updates: unknown[] = [];
  const lifecycle: string[] = [];
  const layer: OptimisticLayer = {
    transaction: recordingTransaction(updates),
    applied() {
      lifecycle.push("applied");
    },
    acknowledged() {
      lifecycle.push("acknowledged");
    },
    rejected() {
      lifecycle.push("rejected");
    },
  };
  const client = gatewayClient({
    registry: clientRegistry,
    transport: directGatewayTransport(
      gateway.forPrincipal({ userId: "alice" }),
    ),
    optimistic: {
      begin(request) {
        assert.deepEqual(request, {
          invocationId: "invocation",
          command: "renameTask",
          input: { id: "task", title: "  After  " },
        });
        return layer;
      },
    },
    createInvocationId: () => "invocation",
  });

  try {
    assert.deepEqual(
      await client.dispatch("renameTask", {
        id: "task",
        title: "  After  ",
      }),
      { id: "task", title: "After" },
    );
    assert.deepEqual(updates, [
      { table: tasks, key: ["task"], changes: { title: "After" } },
    ]);
    assert.deepEqual(lifecycle, ["applied", "acknowledged"]);
    assert.deepEqual(await client.fetch(hydb.query(tasks).many()), [
      { id: "task", title: "After" },
    ]);
  } finally {
    await database.close();
  }
});

test("client validation failures reject optimistic layers", async () => {
  const { database, clientRegistry } = await setup();
  const lifecycle: string[] = [];
  let transportCalls = 0;
  const transport: GatewayClientTransport = {
    async fetch() {
      return [];
    },
    subscribe() {
      return () => undefined;
    },
    async dispatch() {
      transportCalls += 1;
      return { result: { id: "task", title: 42 } };
    },
  };
  const client = gatewayClient({
    registry: clientRegistry,
    transport,
    optimistic: {
      begin() {
        return {
          transaction: recordingTransaction([]),
          applied() {
            lifecycle.push("applied");
          },
          acknowledged() {
            lifecycle.push("acknowledged");
          },
          rejected(error) {
            assert.ok(error instanceof z.ZodError);
            lifecycle.push("rejected");
          },
        };
      },
    },
    createInvocationId: () => "invalid-result",
  });

  try {
    await assert.rejects(
      client.dispatch("renameTask", { id: "task", title: "After" }),
      z.ZodError,
    );
    assert.equal(transportCalls, 1);
    assert.deepEqual(lifecycle, ["applied", "rejected"]);
  } finally {
    await database.close();
  }
});

test("a gateway client rejects an uncompiled server registry", async () => {
  const { database, serverRegistry } = await setup();
  const transport: GatewayClientTransport = {
    async fetch() {
      return [];
    },
    subscribe() {
      return () => undefined;
    },
    async dispatch() {
      return { result: undefined };
    },
  };

  try {
    assert.throws(
      () => gatewayClient({ registry: serverRegistry, transport }),
      /was not compiled for the client target/,
    );
  } finally {
    await database.close();
  }
});
