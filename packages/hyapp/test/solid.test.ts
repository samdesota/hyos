import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { hydb, id, text, type Query } from "@hyos/hydb";
import { createRoot, createSignal } from "solid-js";

import {
  createClientCommandFactory,
  gatewayClient,
  hyapp,
  type GatewayClientTransport,
} from "../src/index.js";
import { createGatewayCommand, createGatewayQuery } from "../src/solid.js";

const tasks = hydb.table("solid_gateway_tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const taskQuery = hydb.query(tasks).many();
const commands = createClientCommandFactory();
const rename = commands.define({
  input: z.object({ id: z.string(), title: z.string() }),
  output: z.object({ id: z.string() }),
});
const registry = hyapp.commandRegistry({ rename });

function tick(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

test("a Solid gateway query follows client changes and cleans subscriptions", async () => {
  const listeners: Array<(result: unknown) => void> = [];
  const disposed: string[] = [];
  const makeClient = (name: string) =>
    gatewayClient({
      registry,
      transport: {
        async fetch() {
          return [{ id: name, title: `Fetched ${name}` }];
        },
        subscribe(_query: Query<any>, listener: (result: unknown) => void) {
          listeners.push(listener);
          return () => disposed.push(name);
        },
        async execute() {
          return { result: { id: name } };
        },
      },
    });
  const [client, setClient] = createSignal(makeClient("one"));
  let dispose!: () => void;
  const state = createRoot((rootDispose) => {
    dispose = rootDispose;
    return createGatewayQuery(client, taskQuery);
  });

  await tick();
  assert.deepEqual(state.data(), [{ id: "one", title: "Fetched one" }]);
  listeners[0]?.([{ id: "live", title: "Live one" }]);
  assert.deepEqual(state.data(), [{ id: "live", title: "Live one" }]);

  setClient(makeClient("two"));
  await tick();
  assert.deepEqual(disposed, ["one"]);
  assert.deepEqual(state.data(), [{ id: "two", title: "Fetched two" }]);

  dispose();
  assert.deepEqual(disposed, ["one", "two"]);
});

test("a Solid gateway command exposes typed pending and error state", async () => {
  let resolveRequest!: (value: { result: { id: string } }) => void;
  const request = new Promise<{ result: { id: string } }>((resolve) => {
    resolveRequest = resolve;
  });
  const transport: GatewayClientTransport = {
    async fetch() {
      return [];
    },
    subscribe() {
      return () => undefined;
    },
    execute() {
      return request;
    },
  };
  const client = gatewayClient({ registry, transport });
  const command = createRoot(() => createGatewayCommand(client, "rename"));
  const execution = command.execute({ id: "task", title: "After" });
  assert.equal(command.pending(), true);
  resolveRequest({ result: { id: "task" } });
  assert.deepEqual(await execution, { id: "task" });
  assert.equal(command.pending(), false);
  assert.equal(command.error(), undefined);

  if (false) {
    // @ts-expect-error title is required by the registered command
    void command.execute({ id: "task" });
  }
});
