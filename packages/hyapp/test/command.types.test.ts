import { z } from "zod";

import { hydb, id, text } from "@hyos/hydb";
import {
  hyapp,
  type InferCommandInput,
  type InferCommandResult,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const principal = z.object({ userId: z.string() });
const tasks = hydb.table("hyapp_typed_tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const writes = hydb.writePolicy(principal);
const commands = hyapp.commandFactory({
  principal,
  defaultPolicy: [writes.allowAll(tasks)],
});

const renameTask = commands.define({
  input: z.object({ id: z.string(), title: z.string() }),
  output: z.object({ id: z.string() }),
  async server({ principal: actor, transaction }, input) {
    const userId: string = actor.userId;
    await transaction.update(tasks, [input.id], { title: input.title });
    return { id: userId };
  },
});

const completeTask = commands.define({
  input: z.object({ id: z.string() }),
  async optimistic({ transaction }, input) {
    await transaction.update(tasks, [input.id], { title: "Complete" });
  },
});

type InputMatches = Expect<
  Equal<InferCommandInput<typeof renameTask>, { id: string; title: string }>
>;
type ResultMatches = Expect<
  Equal<InferCommandResult<typeof renameTask>, { id: string }>
>;
type DefaultResultIsVoid = Expect<
  Equal<InferCommandResult<typeof completeTask>, void>
>;

void (null as unknown as InputMatches);
void (null as unknown as ResultMatches);
void (null as unknown as DefaultResultIsVoid);
