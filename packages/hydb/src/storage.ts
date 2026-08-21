import {
  getColumnDefinition,
  getIndexDefinition,
  getSchemaDefinition,
  getTableDefinition,
  type AnySchema,
  type AnyTable,
  type InferRow,
} from "./schema.js";

export type CommitVersion = number;
export type StorageKey = readonly unknown[];

export type InsertMutation = Readonly<{
  type: "insert";
  table: AnyTable;
  row: Readonly<Record<string, unknown>>;
}>;

export type UpdateMutation = Readonly<{
  type: "update";
  table: AnyTable;
  key: StorageKey;
  row: Readonly<Record<string, unknown>>;
}>;

export type DeleteMutation = Readonly<{
  type: "delete";
  table: AnyTable;
  key: StorageKey;
}>;

export type StorageMutation = InsertMutation | UpdateMutation | DeleteMutation;

export type CommitRequest = Readonly<{
  expectedVersion: CommitVersion;
  mutations: readonly StorageMutation[];
}>;

export type CommittedChange = Readonly<{
  table: AnyTable;
  key: StorageKey;
  before?: Readonly<Record<string, unknown>>;
  after?: Readonly<Record<string, unknown>>;
}>;

export type CommitBatch = Readonly<{
  version: CommitVersion;
  changes: readonly CommittedChange[];
}>;

export type TableScan<TableValue extends AnyTable = AnyTable> = Readonly<{
  type: "table";
  table: TableValue;
}>;

export type IndexScan<TableValue extends AnyTable = AnyTable> = Readonly<{
  type: "index";
  table: TableValue;
  index: string;
  key: StorageKey;
}>;

export type StorageScan<TableValue extends AnyTable = AnyTable> =
  TableScan<TableValue> | IndexScan<TableValue>;

export type ChangeStreamOptions = Readonly<{
  after: CommitVersion;
  signal?: AbortSignal;
}>;

export interface StorageSnapshot {
  readonly version: CommitVersion;

  get<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): Promise<InferRow<TableValue> | undefined>;

  scan<TableValue extends AnyTable>(
    request: StorageScan<TableValue>,
  ): AsyncIterable<readonly InferRow<TableValue>[]>;

  close(): Promise<void>;
}

export interface StorageDatabase {
  snapshot(): Promise<StorageSnapshot>;
  commit(request: CommitRequest): Promise<CommitBatch>;
  changes(options: ChangeStreamOptions): AsyncIterable<CommitBatch>;
  close(): Promise<void>;
}

export class StorageConflictError extends Error {
  constructor(
    readonly expectedVersion: CommitVersion,
    readonly actualVersion: CommitVersion,
  ) {
    super(
      `Storage version conflict: expected ${expectedVersion}, received ${actualVersion}`,
    );
    this.name = "StorageConflictError";
  }
}

type RowTuple = readonly unknown[];

type IndexState = Readonly<{
  name: string;
  unique: boolean;
  columnIndexes: readonly number[];
  entries: ReadonlyMap<string, ReadonlySet<string>>;
}>;

type TableState = Readonly<{
  table: AnyTable;
  columnNames: readonly string[];
  primaryKeyColumns: readonly string[];
  rows: ReadonlyMap<string, RowTuple>;
  indexes: ReadonlyMap<string, IndexState>;
}>;

type StorageState = Readonly<{
  version: CommitVersion;
  tables: ReadonlyMap<string, TableState>;
}>;

function cloneValue<Value>(value: Value): Value {
  return structuredClone(value);
}

function encodePart(value: unknown): string {
  if (value === null) return "n";
  if (typeof value === "string") return `s${value.length}:${value}`;
  if (typeof value === "number")
    return `d${Object.is(value, -0) ? "-0" : value}`;
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (value instanceof Date) return `t${value.getTime()}`;
  throw new TypeError(`Unsupported storage key value: ${String(value)}`);
}

export function encodeStorageKey(key: StorageKey): string {
  return key.map(encodePart).join("|");
}

function rowKey(
  state: TableState,
  row: Readonly<Record<string, unknown>>,
): StorageKey {
  return state.primaryKeyColumns.map((column) => row[column]);
}

function encodeRow(
  state: TableState,
  row: Readonly<Record<string, unknown>>,
): RowTuple {
  return Object.freeze(
    state.columnNames.map((column) => cloneValue(row[column])),
  );
}

function decodeRow(
  state: TableState,
  tuple: RowTuple,
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      state.columnNames.map((column, index) => [
        column,
        cloneValue(tuple[index]),
      ]),
    ),
  );
}

function indexKey(index: IndexState, tuple: RowTuple): string {
  return encodeStorageKey(
    index.columnIndexes.map((position) => tuple[position]),
  );
}

function updateIndexes(
  state: TableState,
  primaryKey: string,
  before: RowTuple | undefined,
  after: RowTuple | undefined,
): ReadonlyMap<string, IndexState> {
  const indexes = new Map<string, IndexState>();

  for (const [name, index] of state.indexes) {
    const entries = new Map(index.entries);

    if (before !== undefined) {
      const key = indexKey(index, before);
      const existing = entries.get(key);
      if (existing !== undefined) {
        const bucket = new Set(existing);
        bucket.delete(primaryKey);
        if (bucket.size === 0) entries.delete(key);
        else entries.set(key, bucket);
      }
    }

    if (after !== undefined) {
      const key = indexKey(index, after);
      const existing = entries.get(key);
      if (
        index.unique &&
        existing !== undefined &&
        (existing.size > 1 || !existing.has(primaryKey))
      ) {
        throw new TypeError(
          `Unique index ${index.name} rejected a duplicate key`,
        );
      }
      const bucket = new Set(existing ?? []);
      bucket.add(primaryKey);
      entries.set(key, bucket);
    }

    indexes.set(name, Object.freeze({ ...index, entries }));
  }

  return indexes;
}

function tableName(table: AnyTable): string {
  return getTableDefinition(table).name;
}

class MemorySnapshot implements StorageSnapshot {
  readonly version: CommitVersion;
  #closed = false;

  constructor(private readonly state: StorageState) {
    this.version = state.version;
  }

  async get<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): Promise<InferRow<TableValue> | undefined> {
    if (this.#closed) throw new Error("Storage snapshot is closed");
    const state = this.state.tables.get(tableName(table));
    if (state === undefined)
      throw new TypeError(`Unknown table: ${tableName(table)}`);
    const tuple = state.rows.get(encodeStorageKey(key));
    return (tuple === undefined ? undefined : decodeRow(state, tuple)) as
      InferRow<TableValue> | undefined;
  }

  async *scan<TableValue extends AnyTable>(
    request: StorageScan<TableValue>,
  ): AsyncIterable<readonly InferRow<TableValue>[]> {
    if (this.#closed) throw new Error("Storage snapshot is closed");
    const state = this.state.tables.get(tableName(request.table));
    if (state === undefined) {
      throw new TypeError(`Unknown table: ${tableName(request.table)}`);
    }

    const tuples: RowTuple[] = [];
    if (request.type === "table") {
      tuples.push(...state.rows.values());
    } else {
      const index = state.indexes.get(request.index);
      if (index === undefined) {
        throw new TypeError(`Unknown index: ${request.index}`);
      }
      const primaryKeys = index.entries.get(encodeStorageKey(request.key));
      if (primaryKeys !== undefined) {
        for (const primaryKey of primaryKeys) {
          const tuple = state.rows.get(primaryKey);
          if (tuple !== undefined) tuples.push(tuple);
        }
      }
    }

    const batch: InferRow<TableValue>[] = [];
    for (const tuple of tuples) {
      batch.push(decodeRow(state, tuple) as InferRow<TableValue>);
      if (batch.length === 1_024) {
        yield Object.freeze([...batch]);
        batch.length = 0;
      }
    }
    if (batch.length > 0) yield Object.freeze([...batch]);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

class MemoryStorage implements StorageDatabase {
  #closed = false;
  readonly #history: CommitBatch[] = [];
  readonly #subscribers = new Set<{
    after: CommitVersion;
    queue: CommitBatch[];
    wake?: () => void;
  }>();

  constructor(private state: StorageState) {}

  async snapshot(): Promise<StorageSnapshot> {
    this.assertOpen();
    return new MemorySnapshot(this.state);
  }

  async commit(request: CommitRequest): Promise<CommitBatch> {
    this.assertOpen();
    if (request.expectedVersion !== this.state.version) {
      throw new StorageConflictError(
        request.expectedVersion,
        this.state.version,
      );
    }

    const tables = new Map(this.state.tables);
    const changes: CommittedChange[] = [];

    for (const mutation of request.mutations) {
      const name = tableName(mutation.table);
      const current = tables.get(name);
      if (current === undefined) throw new TypeError(`Unknown table: ${name}`);

      const key =
        mutation.type === "insert"
          ? rowKey(current, mutation.row)
          : mutation.key;
      const encodedKey = encodeStorageKey(key);
      const rows = new Map(current.rows);
      const beforeTuple = current.rows.get(encodedKey);

      if (mutation.type === "insert") {
        if (rows.has(encodedKey)) {
          throw new TypeError(`Duplicate primary key for table ${name}`);
        }
        rows.set(encodedKey, encodeRow(current, mutation.row));
      } else {
        if (beforeTuple === undefined) {
          throw new TypeError(`Missing row for table ${name}`);
        }

        if (mutation.type === "update") {
          const nextKey = rowKey(current, mutation.row);
          if (encodeStorageKey(nextKey) !== encodedKey) {
            throw new TypeError(
              `Primary keys cannot be updated for table ${name}`,
            );
          }
          rows.set(encodedKey, encodeRow(current, mutation.row));
        } else {
          rows.delete(encodedKey);
        }
      }

      const afterTuple = rows.get(encodedKey);
      const indexes = updateIndexes(
        current,
        encodedKey,
        beforeTuple,
        afterTuple,
      );
      const next = Object.freeze({ ...current, rows, indexes });
      tables.set(name, next);

      changes.push(
        Object.freeze({
          table: mutation.table,
          key: Object.freeze([...key]),
          ...(beforeTuple === undefined
            ? {}
            : { before: decodeRow(current, beforeTuple) }),
          ...(afterTuple === undefined
            ? {}
            : { after: decodeRow(next, afterTuple) }),
        }),
      );
    }

    const version = this.state.version + 1;
    this.state = Object.freeze({ version, tables });
    const commit = Object.freeze({
      version,
      changes: Object.freeze(changes),
    });
    this.#history.push(commit);
    for (const subscriber of this.#subscribers) {
      if (commit.version <= subscriber.after) continue;
      subscriber.queue.push(commit);
      subscriber.after = commit.version;
      subscriber.wake?.();
      subscriber.wake = undefined;
    }
    return commit;
  }

  async *changes(options: ChangeStreamOptions): AsyncIterable<CommitBatch> {
    this.assertOpen();
    const queue = this.#history.filter(
      (commit) => commit.version > options.after,
    );
    const subscriber = {
      after: queue.at(-1)?.version ?? options.after,
      queue,
      wake: undefined as (() => void) | undefined,
    };
    const wakeOnAbort = () => subscriber.wake?.();
    options.signal?.addEventListener("abort", wakeOnAbort, { once: true });
    this.#subscribers.add(subscriber);

    try {
      while (!this.#closed && options.signal?.aborted !== true) {
        const commit = subscriber.queue.shift();
        if (commit !== undefined) {
          yield commit;
          continue;
        }
        await new Promise<void>((resolve) => {
          subscriber.wake = resolve;
        });
      }
    } finally {
      options.signal?.removeEventListener("abort", wakeOnAbort);
      this.#subscribers.delete(subscriber);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const subscriber of this.#subscribers) subscriber.wake?.();
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Storage database is closed");
  }
}

export async function memoryStorage(options: {
  schema: AnySchema;
}): Promise<StorageDatabase> {
  const definitions = Object.values(getSchemaDefinition(options.schema).tables);
  const tables = new Map<string, TableState>();

  for (const table of definitions) {
    const definition = getTableDefinition(table);
    const columns = Object.entries(definition.columns);
    const primaryKeyColumns = columns
      .filter(([, column]) => getColumnDefinition(column).primaryKey)
      .map(([name]) => name);
    const columnPositions = new Map(
      columns.map(([name], position) => [name, position]),
    );
    const indexes = new Map<string, IndexState>();
    for (const value of definition.indexes) {
      const index = getIndexDefinition(value);
      indexes.set(
        index.name,
        Object.freeze({
          name: index.name,
          unique: index.unique,
          columnIndexes: Object.freeze(
            index.columns.map((column) => {
              const position = columnPositions.get(
                getColumnDefinition(column).name,
              );
              if (position === undefined) {
                throw new TypeError(`Unknown indexed column for ${index.name}`);
              }
              return position;
            }),
          ),
          entries: new Map(),
        }),
      );
    }

    tables.set(
      definition.name,
      Object.freeze({
        table,
        columnNames: Object.freeze(columns.map(([name]) => name)),
        primaryKeyColumns: Object.freeze(primaryKeyColumns),
        rows: new Map(),
        indexes,
      }),
    );
  }

  return new MemoryStorage(Object.freeze({ version: 0, tables }));
}

export const storageMutation = {
  insert<TableValue extends AnyTable>(
    table: TableValue,
    row: InferRow<TableValue>,
  ): InsertMutation {
    return Object.freeze({
      type: "insert",
      table,
      row: row as Readonly<Record<string, unknown>>,
    });
  },

  update<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
    row: InferRow<TableValue>,
  ): UpdateMutation {
    return Object.freeze({
      type: "update",
      table,
      key: Object.freeze([...key]),
      row: row as Readonly<Record<string, unknown>>,
    });
  },

  delete<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): DeleteMutation {
    return Object.freeze({
      type: "delete",
      table,
      key: Object.freeze([...key]),
    });
  },
};
