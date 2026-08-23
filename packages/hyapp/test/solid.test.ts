import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { hydb, id, text, type Query } from "@hyos/hydb";
import { createEffect, createRoot, createSignal } from "solid-js";

import {
  createClientCommandFactory,
  gatewayClient,
  hyapp,
  type GatewayClientTransport,
} from "../src/index.js";
import { createCommandDispatcher, createGatewayQuery } from "../src/solid.js";

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
        async dispatch() {
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

test("a Solid command dispatcher types commands and settles pending after all work", async () => {
  const requests: Array<{
    resolve(value: { result: { id: string } }): void;
  }> = [];
  const transport: GatewayClientTransport = {
    async fetch() {
      return [];
    },
    subscribe() {
      return () => undefined;
    },
    dispatch() {
      return new Promise((resolve) => requests.push({ resolve }));
    },
  };
  const client = gatewayClient({ registry, transport });
  const observedPending: boolean[] = [];
  const dispatch = createRoot(() => {
    const dispatcher = createCommandDispatcher(client);
    createEffect(() => observedPending.push(dispatcher.isPending("rename")));
    return dispatcher;
  });
  await tick();
  assert.deepEqual(observedPending, [false]);

  const first = dispatch("rename", { id: "first", title: "After" });
  const second = dispatch("rename", { id: "second", title: "Later" });
  assert.equal(dispatch.isPending("rename"), true);
  await tick();
  assert.deepEqual(observedPending, [false, true]);
  for (let index = 0; index < 10 && requests.length < 2; index += 1) {
    await tick();
  }
  assert.equal(requests.length, 2);

  requests[0]!.resolve({ result: { id: "first" } });
  assert.deepEqual(await first, { id: "first" });
  assert.equal(dispatch.isPending("rename"), true);
  await tick();
  assert.deepEqual(observedPending, [false, true]);

  requests[1]!.resolve({ result: { id: "second" } });
  assert.deepEqual(await second, { id: "second" });
  assert.equal(dispatch.isPending("rename"), false);
  await tick();
  assert.deepEqual(observedPending, [false, true, false]);

  if (false) {
    // @ts-expect-error title is required by the registered command
    void dispatch("rename", { id: "task" });
    // @ts-expect-error pending state is limited to registered commands
    dispatch.isPending("missing");
  }
});
