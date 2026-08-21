import {
  hydb,
  id,
  integer,
  text,
  type Database,
  type InferCommandInput,
  type InferCommandResult,
} from "../src/index.js";
import { z } from "zod";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type Simplify<Value> = { [Key in keyof Value]: Value[Key] };

const tasks = hydb.table("typed_command_tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
  priority: integer().notNull().default(0),
  note: text(),
});

const createTask = hydb.command({
  input: z.object({ id: z.string(), title: z.string() }),
  handler: async (tx, input) => {
    const inserted = tx.insert(tasks, input);
    const fetched = tx.get(tasks, [input.id]);
    tx.update(tasks, [input.id], { priority: 10, note: "Selected" });
    tx.delete(tasks, [input.id]);

    // @ts-expect-error primary keys cannot be updated
    tx.update(tasks, [input.id], { id: "replacement" });
    // @ts-expect-error title is required on inserts
    tx.insert(tasks, { id: "missing-title" });
    // @ts-expect-error priority must be numeric
    tx.update(tasks, [input.id], { priority: "high" });

    return { inserted, fetched };
  },
});

const transformedInput = hydb.command({
  input: z.object({ value: z.string().transform((value) => value.length) }),
  handler: (_tx, input) => input.value,
});

type CommandInputMatches = Expect<
  Equal<InferCommandInput<typeof createTask>, { id: string; title: string }>
>;
type CommandResultMatches = Expect<
  Equal<
    InferCommandResult<typeof createTask>,
    {
      inserted: {
        id: string;
        title: string;
        priority: number;
        note: string | null;
      };
      fetched:
        | {
            id: string;
            title: string;
            priority: number;
            note: string | null;
          }
        | undefined;
    }
  >
>;
type TransformedInputMatches = Expect<
  Equal<Simplify<InferCommandInput<typeof transformedInput>>, { value: string }>
>;
type TransformedResultMatches = Expect<
  Equal<InferCommandResult<typeof transformedInput>, number>
>;

function acceptsTypedExecution(db: Database): void {
  const execution = db.execute(createTask, { id: "task", title: "Typed" });
  type ExecutionMatches = Expect<
    Equal<Awaited<typeof execution>, InferCommandResult<typeof createTask>>
  >;

  // @ts-expect-error command input requires title
  void db.execute(createTask, { id: "task" });
  // @ts-expect-error command input rejects incompatible values
  void db.execute(createTask, { id: 123, title: "Typed" });
  void (null as unknown as ExecutionMatches);
}

void acceptsTypedExecution;
void (null as unknown as CommandInputMatches);
void (null as unknown as CommandResultMatches);
void (null as unknown as TransformedInputMatches);
void (null as unknown as TransformedResultMatches);
