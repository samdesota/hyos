import { z } from "zod";

import {
  hydb,
  id,
  type Database,
  type InferGatewayCommands,
} from "../src/index.js";

const records = hydb.table("gateway_type_records", {
  id: id().primaryKey(),
});

const updateRecord = hydb.command({
  input: z.object({ id: z.string() }),
  handler: (_transaction, input) => ({ id: input.id }),
});

function acceptsTypedGateway(database: Database): void {
  const principal = z.object({ userId: z.string() });
  const policies = hydb.readPolicy(principal);
  const gateway = hydb.gateway({
    database,
    principal,
    commands: { updateRecord },
    readPolicies: [policies.allowAll(records)],
  });

  const session = gateway.forPrincipal({ userId: "alice" });
  void session.fetch(hydb.query(records).many());
  void session.execute("updateRecord", { id: "record" });

  type Commands = InferGatewayCommands<typeof gateway>;

  const command: keyof Commands = "updateRecord";
  void command;

  // @ts-expect-error unknown commands are not exposed by the gateway
  void session.execute("deleteRecord", { id: "record" });

  // @ts-expect-error command input remains strongly typed
  void session.execute("updateRecord", { id: 42 });

  // @ts-expect-error principal input is validated and strongly typed
  gateway.forPrincipal({ userId: 42 });
}

void acceptsTypedGateway;
