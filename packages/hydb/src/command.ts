import {
  getColumnDefinition,
  getSchemaDefinition,
  getTableDefinition,
  type AnySchema,
  type AnyTable,
  type InferInsert,
  type InferRow,
  type InferUpdate,
} from "./schema.js";
import {
  encodeStorageKey,
  storageMutation,
  type StorageKey,
  type StorageMutation,
  type StorageSnapshot,
} from "./storage.js";
import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";
import {
  estimateMemoryBytes,
  type MemoryHandle,
  type MemoryManager,
} from "./memory.js";

const commandDefinition = Symbol("hydb.command");
const missingRow = Symbol("hydb.missing-row");
const deletedRow = Symbol("hydb.deleted-row");

type StoredRow = Readonly<Record<string, unknown>>;
export interface Transaction {
  get<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): Promise<InferRow<TableValue> | undefined>;

  insert<TableValue extends AnyTable>(
    table: TableValue,
    values: InferInsert<TableValue>,
  ): Promise<InferRow<TableValue>>;

  update<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
    changes: InferUpdate<TableValue>,
  ): Promise<InferRow<TableValue>>;

  delete<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): Promise<void>;
}

export type Command<Input, Result, ParsedInput = Input> = Readonly<{
  [commandDefinition]: {
    input: ZodType<ParsedInput, Input>;
    handler: (
      transaction: Transaction,
      input: ParsedInput,
    ) => Result | PromiseLike<Result>;
  };
}>;

export type InferCommandInput<CommandValue extends Command<any, any, any>> =
  CommandValue extends Command<infer Input, any, any> ? Input : never;

export type InferCommandResult<CommandValue extends Command<any, any, any>> =
  CommandValue extends Command<any, infer Result, any> ? Result : never;

export function command<InputSchema extends ZodType, Result>(definition: {
  input: InputSchema;
  handler: (
    transaction: Transaction,
    input: ZodOutput<InputSchema>,
  ) => Result | PromiseLike<Result>;
}): Command<ZodInput<InputSchema>, Awaited<Result>, ZodOutput<InputSchema>> {
  return Object.freeze({
    [commandDefinition]: Object.freeze({
      input: definition.input as unknown as ZodType<
        ZodOutput<InputSchema>,
        ZodInput<InputSchema>
      >,
      handler: definition.handler as Command<
        ZodInput<InputSchema>,
        Awaited<Result>,
        ZodOutput<InputSchema>
      >[typeof commandDefinition]["handler"],
    }),
  });
}

class CommandTransaction implements Transaction {
  readonly #overlays = new Map<
    string,
    Map<string, StoredRow | typeof deletedRow>
  >();
  readonly #mutations: StorageMutation[] = [];
  readonly #reads = new Map<
    string,
    Map<string, StoredRow | typeof missingRow>
  >();
  #active = true;
  readonly #memory?: MemoryHandle;
  readonly #memoryEntries = new Map<string, number>();
  #memoryBytes = 0;

  constructor(
    private readonly schema: AnySchema,
    private readonly snapshot: StorageSnapshot,
    memory?: MemoryManager,
  ) {
    this.#memory = memory?.track({ owner: "transactions", priority: 50 });
  }

  async get<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): Promise<InferRow<TableValue> | undefined> {
    this.assertActive();
    this.assertTable(table);
    const encodedKey = encodeStorageKey(key);
    const name = tableName(table);
    const writes = this.#overlays.get(name);
    const overlay = writes?.get(encodedKey);
    if (overlay === deletedRow) return undefined;
    if (overlay !== undefined) {
      return structuredClone(overlay) as InferRow<TableValue>;
    }

    let tableReads = this.#reads.get(name);
    if (tableReads === undefined) {
      tableReads = new Map();
      this.#reads.set(name, tableReads);
    }
    let row = tableReads.get(encodedKey);
    if (row === undefined) {
      row = (await this.snapshot.get(table, key)) ?? missingRow;
      tableReads.set(encodedKey, row);
      this.account(`read:${name}:${encodedKey}`, row);
    }
    if (row === missingRow) return undefined;
    return structuredClone(row) as InferRow<TableValue>;
  }

  async insert<TableValue extends AnyTable>(
    table: TableValue,
    values: InferInsert<TableValue>,
  ): Promise<InferRow<TableValue>> {
    this.assertActive();
    this.assertTable(table);
    const row = materializeInsert(table, values);
    const key = keyForRow(table, row);
    if ((await this.get(table, key)) !== undefined) {
      throw new TypeError(
        `Duplicate primary key for table ${tableName(table)}`,
      );
    }
    this.setOverlay(table, key, row);
    this.#mutations.push(storageMutation.insert(table, row));
    this.accountMutation();
    return structuredClone(row);
  }

  async update<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
    changes: InferUpdate<TableValue>,
  ): Promise<InferRow<TableValue>> {
    this.assertActive();
    this.assertTable(table);
    const current = await this.get(table, key);
    if (current === undefined) {
      throw new TypeError(`Missing row for table ${tableName(table)}`);
    }
    assertUpdateColumns(table, changes as Readonly<Record<string, unknown>>);
    const row = Object.freeze({ ...current, ...structuredClone(changes) });
    if (encodeStorageKey(keyForRow(table, row)) !== encodeStorageKey(key)) {
      throw new TypeError(
        `Primary keys cannot be updated for table ${tableName(table)}`,
      );
    }
    this.setOverlay(table, key, row);
    this.#mutations.push(
      storageMutation.update(table, key, row as InferRow<TableValue>),
    );
    this.accountMutation();
    return structuredClone(row) as InferRow<TableValue>;
  }

  async delete<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): Promise<void> {
    this.assertActive();
    this.assertTable(table);
    if ((await this.get(table, key)) === undefined) {
      throw new TypeError(`Missing row for table ${tableName(table)}`);
    }
    const encodedKey = encodeStorageKey(key);
    this.overlay(table).set(encodedKey, deletedRow);
    this.account(`write:${tableName(table)}:${encodedKey}`, deletedRow);
    this.#mutations.push(storageMutation.delete(table, key));
    this.accountMutation();
  }

  finish(): readonly StorageMutation[] {
    this.assertActive();
    this.#active = false;
    return Object.freeze([...this.#mutations]);
  }

  abort(): void {
    this.#active = false;
    this.releaseMemory();
  }

  releaseMemory(): void {
    this.#memoryEntries.clear();
    this.#memoryBytes = 0;
    this.#memory?.release();
  }

  private overlay(table: AnyTable): Map<string, StoredRow | typeof deletedRow> {
    this.assertTable(table);
    const name = tableName(table);
    let overlay = this.#overlays.get(name);
    if (overlay === undefined) {
      overlay = new Map();
      this.#overlays.set(name, overlay);
    }
    return overlay;
  }

  private setOverlay(table: AnyTable, key: StorageKey, row: StoredRow): void {
    const encodedKey = encodeStorageKey(key);
    this.overlay(table).set(encodedKey, row);
    this.account(`write:${tableName(table)}:${encodedKey}`, row);
  }

  private account(key: string, value: unknown): void {
    const bytes = 64 + estimateMemoryBytes(key) + estimateMemoryBytes(value);
    this.#memoryBytes += bytes - (this.#memoryEntries.get(key) ?? 0);
    this.#memoryEntries.set(key, bytes);
    this.#memory?.resize(this.#memoryBytes);
  }

  private accountMutation(): void {
    const index = this.#mutations.length - 1;
    this.account(`mutation:${index}`, this.#mutations[index]);
  }

  private assertActive(): void {
    if (!this.#active) throw new Error("Transaction is no longer active");
  }

  private assertTable(table: AnyTable): void {
    const definition = getSchemaDefinition(this.schema);
    const known = Object.values(definition.tables).some(
      (candidate) => candidate === table,
    );
    if (!known) throw new TypeError(`Unknown table: ${tableName(table)}`);
  }
}

function tableName(table: AnyTable): string {
  return getTableDefinition(table).name;
}

function keyForRow(table: AnyTable, row: StoredRow): StorageKey {
  return Object.entries(getTableDefinition(table).columns)
    .filter(([, column]) => getColumnDefinition(column).primaryKey)
    .map(([name]) => row[name]);
}

function materializeInsert<TableValue extends AnyTable>(
  table: TableValue,
  values: InferInsert<TableValue>,
): InferRow<TableValue> {
  const input = values as Readonly<Record<string, unknown>>;
  const row: Record<string, unknown> = {};
  for (const [name, column] of Object.entries(
    getTableDefinition(table).columns,
  )) {
    const definition = getColumnDefinition(column);
    if (Object.hasOwn(input, name)) row[name] = structuredClone(input[name]);
    else if (definition.hasDefault) {
      row[name] = structuredClone(definition.defaultValue);
    } else if (definition.notNull) {
      throw new TypeError(
        `Missing required column ${tableName(table)}.${name}`,
      );
    } else row[name] = null;
  }
  return Object.freeze(row) as InferRow<TableValue>;
}

function assertUpdateColumns(
  table: AnyTable,
  changes: Readonly<Record<string, unknown>>,
): void {
  const definition = getTableDefinition(table);
  for (const name of Object.keys(changes)) {
    const column = definition.columns[name];
    if (column === undefined) {
      throw new TypeError(`Unknown column ${definition.name}.${name}`);
    }
    if (getColumnDefinition(column).primaryKey) {
      throw new TypeError(
        `Primary keys cannot be updated for table ${definition.name}`,
      );
    }
  }
}

export async function invokeCommand<Input, Result, ParsedInput>(
  value: Command<Input, Result, ParsedInput>,
  input: Input,
  schema: AnySchema,
  snapshot: StorageSnapshot,
  memory?: MemoryManager,
): Promise<
  Readonly<{
    result: Result;
    mutations: readonly StorageMutation[];
    releaseMemory: () => void;
  }>
> {
  const parsedInput = await value[commandDefinition].input.parseAsync(input);
  const transaction = new CommandTransaction(schema, snapshot, memory);
  try {
    const result = await value[commandDefinition].handler(
      transaction,
      parsedInput,
    );
    return Object.freeze({
      result,
      mutations: transaction.finish(),
      releaseMemory: () => transaction.releaseMemory(),
    });
  } catch (error) {
    transaction.abort();
    throw error;
  }
}
