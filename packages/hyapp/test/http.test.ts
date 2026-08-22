import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { z } from "zod";

import {
  hydb,
  id,
  memoryStorage,
  storageMutation,
  text,
  timestamp,
} from "@hyos/hydb";

import {
  createClientCommandFactory,
  gatewayClient,
  hyapp,
} from "../src/index.js";
import { GatewayHttpError, httpGatewayTransport } from "../src/http.js";
import { createNodeGatewayHttpHandler } from "../src/node/index.js";

const principal = z.object({ userId: z.string() });
const tasks = hydb.table("http_gateway_tasks", {
  id: id().primaryKey(),
  ownerId: id().notNull(),
  title: text().notNull(),
  updatedAt: timestamp().notNull(),
});
const schema = hydb.schema({ tasks });
const taskQuery = hydb
  .query(tasks)
  .orderBy((task) => task.id.asc())
  .many();
const reads = hyapp.gatewayReadRegistry({ tasks: taskQuery });
const input = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.date(),
});
const output = z.object({ id: z.string(), updatedAt: z.date() });

test("the HTTP adapter carries authorized reads, subscriptions, and commands", async () => {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(tasks, {
        id: "alice-task",
        ownerId: "alice",
        title: "Before",
        updatedAt: new Date("2026-08-22T10:00:00.000Z"),
      }),
      storageMutation.insert(tasks, {
        id: "bob-task",
        ownerId: "bob",
        title: "Private",
        updatedAt: new Date("2026-08-22T10:00:00.000Z"),
      }),
    ],
  });
  const database = await hydb.database({ schema, storage });
  const write = hydb.writePolicy(principal);
  const serverCommands = hyapp.commandFactory({
    principal,
    defaultPolicy: [
      write.where(tasks, ({ change, principal: actor }) => {
        const before = change.kind === "insert" ? undefined : change.before;
        const after = change.kind === "delete" ? undefined : change.after;
        return (
          (before === undefined || before.ownerId === actor.userId) &&
          (after === undefined || after.ownerId === actor.userId)
        );
      }),
    ],
  });
  const serverRename = serverCommands.define({
    input,
    output,
    async optimistic({ transaction }, value) {
      await transaction.update(tasks, [value.id], {
        title: value.title,
        updatedAt: value.updatedAt,
      });
    },
    async server({ applyOptimistic }, value) {
      await applyOptimistic();
      return { id: value.id, updatedAt: value.updatedAt };
    },
  });
  const serverRegistry = hyapp.commandRegistry({ rename: serverRename });
  const read = hydb.readPolicy(principal);
  const gateway = hyapp.gateway({
    database,
    principal,
    registry: serverRegistry,
    readPolicies: [
      read.where(tasks, ({ row, principal: actor }) =>
        row.ownerId.eq(actor.userId),
      ),
    ],
  });
  const handler = createNodeGatewayHttpHandler({
    gateway,
    reads,
    principal(request) {
      const userId = request.headers["x-user-id"];
      if (typeof userId !== "string") {
        throw new GatewayHttpError(401, "Sign in required");
      }
      return { userId };
    },
  });
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response))) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP test server did not expose a port");
  }

  const clientCommands = createClientCommandFactory();
  const clientRename = clientCommands.define({ input, output });
  const client = gatewayClient({
    registry: hyapp.commandRegistry({ rename: clientRename }),
    transport: httpGatewayTransport({
      reads,
      baseUrl: `http://127.0.0.1:${address.port}/api/hyapp`,
      headers: () => ({ "x-user-id": "alice" }),
    }),
  });

  try {
    assert.deepEqual(await client.fetch(taskQuery), [
      {
        id: "alice-task",
        ownerId: "alice",
        title: "Before",
        updatedAt: new Date("2026-08-22T10:00:00.000Z"),
      },
    ]);

    let resolveUpdated!: () => void;
    const updated = new Promise<void>((resolve) => {
      resolveUpdated = resolve;
    });
    const unsubscribe = client.subscribe(taskQuery, (rows) => {
      if (rows[0]?.title === "After") resolveUpdated();
    });
    const updatedAt = new Date("2026-08-22T11:00:00.000Z");
    assert.deepEqual(
      await client.execute("rename", {
        id: "alice-task",
        title: "After",
        updatedAt,
      }),
      { id: "alice-task", updatedAt },
    );
    await updated;
    unsubscribe();

    await assert.rejects(
      client.execute("rename", {
        id: "bob-task",
        title: "Stolen",
        updatedAt,
      }),
      (error: unknown) =>
        error instanceof GatewayHttpError && error.status === 403,
    );
  } finally {
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
    server.closeAllConnections();
    await closed;
    await database.close();
  }
});
