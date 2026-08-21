import {
  getColumnDefinition,
  getTableDefinition,
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
} from "./storage.js";
import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";

const commandDefinition = Symbol("hydb.command");
const deletedRow = Symbol("hydb.deleted-row");

type StoredRow = Readonly<Record<string, unknown>>;
type TableRows = ReadonlyMap<string, ReadonlyMap<string, StoredRow>>;

export interface Transaction {
  get<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): InferRow<TableValue> | undefined;

  insert<TableValue extends AnyTable>(
    table: TableValue,
    values: InferInsert<TableValue>,
  ): InferRow<TableValue>;

  update<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
    changes: InferUpdate<TableValue>,
  ): InferRow<TableValue>;

  delete<TableValue extends AnyTable>(table: TableValue, key: StorageKey): void;
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
  readonly #tables: TableRows;
  #active = true;

  constructor(tables: TableRows) {
    this.#tables = new Map(
      [...tables].map(([name, rows]) => [name, new Map(rows)]),
    );
  }

  get<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): InferRow<TableValue> | undefined {
    this.assertActive();
    const encodedKey = encodeStorageKey(key);
    const overlay = this.#overlays.get(tableName(table))?.get(encodedKey);
    if (overlay === deletedRow) return undefined;
    const row = overlay ?? this.tableRows(table).get(encodedKey);
    return row === undefined
      ? undefined
      : (structuredClone(row) as InferRow<TableValue>);
  }

  insert<TableValue extends AnyTable>(
    table: TableValue,
    values: InferInsert<TableValue>,
  ): InferRow<TableValue> {
    this.assertActive();
    const row = materializeInsert(table, values);
    const key = keyForRow(table, row);
    if (this.get(table, key) !== undefined) {
      throw new TypeError(
        `Duplicate primary key for table ${tableName(table)}`,
      );
    }
    this.setOverlay(table, key, row);
    this.#mutations.push(storageMutation.insert(table, row));
    return structuredClone(row);
  }

  update<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
    changes: InferUpdate<TableValue>,
  ): InferRow<TableValue> {
    this.assertActive();
    const current = this.get(table, key);
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
    return structuredClone(row) as InferRow<TableValue>;
  }

  delete<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): void {
    this.assertActive();
    if (this.get(table, key) === undefined) {
      throw new TypeError(`Missing row for table ${tableName(table)}`);
    }
    this.overlay(table).set(encodeStorageKey(key), deletedRow);
    this.#mutations.push(storageMutation.delete(table, key));
  }

  finish(): readonly StorageMutation[] {
    this.assertActive();
    this.#active = false;
    return Object.freeze([...this.#mutations]);
  }

  abort(): void {
    this.#active = false;
  }

  private tableRows(table: AnyTable): ReadonlyMap<string, StoredRow> {
    const rows = this.#tables.get(tableName(table));
    if (rows === undefined)
      throw new TypeError(`Unknown table: ${tableName(table)}`);
    return rows;
  }

  private overlay(table: AnyTable): Map<string, StoredRow | typeof deletedRow> {
    this.tableRows(table);
    const name = tableName(table);
    let overlay = this.#overlays.get(name);
    if (overlay === undefined) {
      overlay = new Map();
      this.#overlays.set(name, overlay);
    }
    return overlay;
  }

  private setOverlay(table: AnyTable, key: StorageKey, row: StoredRow): void {
    this.overlay(table).set(encodeStorageKey(key), row);
  }

  private assertActive(): void {
    if (!this.#active) throw new Error("Transaction is no longer active");
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
  tables: TableRows,
): Promise<
  Readonly<{ result: Result; mutations: readonly StorageMutation[] }>
> {
  const parsedInput = await value[commandDefinition].input.parseAsync(input);
  const transaction = new CommandTransaction(tables);
  try {
    const result = await value[commandDefinition].handler(
      transaction,
      parsedInput,
    );
    return Object.freeze({ result, mutations: transaction.finish() });
  } catch (error) {
    transaction.abort();
    throw error;
  }
}
