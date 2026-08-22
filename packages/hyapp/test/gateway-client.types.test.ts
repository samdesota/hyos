import { z } from "zod";

import { hydb, id, text, type Query } from "@hyos/hydb";
import {
  createClientCommandFactory,
  gatewayClient,
  hyapp,
  type GatewayClientTransport,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const tasks = hydb.table("typed_gateway_client_tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const commands = createClientCommandFactory();
const renameTask = commands.define({
  input: z.object({ id: z.string(), title: z.string() }),
  output: z.object({ id: z.string() }),
});
const registry = hyapp.commandRegistry({ renameTask });
const transport: GatewayClientTransport = {
  async fetch() {
    return undefined;
  },
  subscribe(_query: Query<any>, _listener: (result: unknown) => void) {
    return () => undefined;
  },
  async execute() {
    return { result: { id: "task" } };
  },
};
const client = gatewayClient({ registry, transport });

const execution = client.execute("renameTask", {
  id: "task",
  title: "Typed",
});
type ResultMatches = Expect<Equal<Awaited<typeof execution>, { id: string }>>;

const fetch = client.fetch(hydb.query(tasks).many());
type FetchMatches = Expect<
  Equal<Awaited<typeof fetch>, Array<{ id: string; title: string }>>
>;

if (false) {
  // @ts-expect-error unknown registry command
  void client.execute("deleteTask", { id: "task" });
  // @ts-expect-error title is required
  void client.execute("renameTask", { id: "task" });
  // @ts-expect-error id must be a string
  void client.execute("renameTask", { id: 42, title: "Typed" });
}

void (null as unknown as ResultMatches);
void (null as unknown as FetchMatches);
