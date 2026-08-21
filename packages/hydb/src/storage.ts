import {
  getColumnDefinition,
  getIndexDefinition,
  getSchemaDefinition,
  getTableDefinition,
  type AnySchema,
  type AnyTable,
  type InferRow,
} from "./schema.js";

export type CommitId = string;
export type BranchName = string;
export type BranchSequence = number;
/** @deprecated Use BranchSequence for live ordering and CommitId for identity. */
export type CommitVersion = BranchSequence;
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
  branch?: BranchName;
  mutations: readonly StorageMutation[];
}> &
  (
    | Readonly<{ expectedHead: CommitId; expectedVersion?: never }>
    | Readonly<{
        expectedHead?: never;
        /** @deprecated Compatibility with the original single-main-branch interface. */
        expectedVersion: CommitVersion;
      }>
  );

export type CommittedChange = Readonly<{
  table: AnyTable;
  key: StorageKey;
  before?: Readonly<Record<string, unknown>>;
  after?: Readonly<Record<string, unknown>>;
}>;

export type CommitBatch = Readonly<{
  commit: CommitId;
  branch: BranchName;
  sequence: BranchSequence;
  parent: CommitId;
  /** @deprecated Alias for sequence. */
  version: CommitVersion;
  changes: readonly CommittedChange[];
}>;

export type TableScan<TableValue extends AnyTable = AnyTable> = Readonly<{
  type: "table";
  table: TableValue;
  range?: StorageRange;
}>;

export type IndexScan<TableValue extends AnyTable = AnyTable> = Readonly<{
  type: "index";
  table: TableValue;
  index: string;
  key?: StorageKey;
  range?: StorageRange;
}>;

export type StorageRange = Readonly<{
  gt?: StorageKey;
  gte?: StorageKey;
  lt?: StorageKey;
  lte?: StorageKey;
  reverse?: boolean;
  limit?: number;
}>;

export type StorageScan<TableValue extends AnyTable = AnyTable> =
  TableScan<TableValue> | IndexScan<TableValue>;

export type ChangeStreamOptions = Readonly<{
  branch?: BranchName;
  after: BranchSequence;
  signal?: AbortSignal;
}>;

export type SnapshotSelector =
  Readonly<{ branch: BranchName }> | Readonly<{ commit: CommitId }>;

export interface StorageSnapshot {
  readonly commit: CommitId;
  readonly branch?: BranchName;
  readonly sequence: BranchSequence;
  /** @deprecated Alias for sequence. */
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
  snapshot(selector?: SnapshotSelector): Promise<StorageSnapshot>;
  head(branch?: BranchName): Promise<CommitId>;
  createBranch(request: { name: BranchName; from: CommitId }): Promise<void>;
  commit(request: CommitRequest): Promise<CommitBatch>;
  changes(options: ChangeStreamOptions): AsyncIterable<CommitBatch>;
  close(): Promise<void>;
}

export class StorageConflictError extends Error {
  readonly expectedHead?: CommitId;
  readonly actualHead?: CommitId;
  readonly expectedVersion?: CommitVersion;
  readonly actualVersion?: CommitVersion;

  constructor(
    expected: CommitId | CommitVersion,
    actual: CommitId | CommitVersion,
  ) {
    super(`Storage conflict: expected ${expected}, received ${actual}`);
    this.name = "StorageConflictError";
    if (typeof expected === "number" && typeof actual === "number") {
      this.expectedVersion = expected;
      this.actualVersion = actual;
    } else if (typeof expected === "string" && typeof actual === "string") {
      this.expectedHead = expected;
      this.actualHead = actual;
    }
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
  commit: CommitId;
  sequence: BranchSequence;
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

function compareStorageValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  const rank = (value: unknown): number => {
    if (value === null) return 0;
    if (typeof value === "boolean") return 1;
    if (typeof value === "number") return 2;
    if (value instanceof Date) return 3;
    if (typeof value === "string") return 4;
    throw new TypeError(`Unsupported storage key value: ${String(value)}`);
  };
  const leftRank = rank(left);
  const rightRank = rank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }
  return left! < right! ? -1 : 1;
}

function compareStorageKeys(left: StorageKey, right: StorageKey): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareStorageValues(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function storageKeyInRange(key: StorageKey, range: StorageRange): boolean {
  if (range.gt !== undefined && compareStorageKeys(key, range.gt) <= 0)
    return false;
  if (range.gte !== undefined && compareStorageKeys(key, range.gte) < 0)
    return false;
  if (range.lt !== undefined && compareStorageKeys(key, range.lt) >= 0)
    return false;
  if (range.lte !== undefined && compareStorageKeys(key, range.lte) > 0)
    return false;
  return true;
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
  readonly commit: CommitId;
  readonly branch?: BranchName;
  readonly sequence: BranchSequence;
  readonly version: CommitVersion;
  #closed = false;

  constructor(
    private readonly state: StorageState,
    branch?: BranchName,
    sequence = state.sequence,
  ) {
    this.commit = state.commit;
    this.branch = branch;
    this.sequence = sequence;
    this.version = sequence;
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

    const index =
      request.type === "index" ? state.indexes.get(request.index) : undefined;
    if (request.type === "index" && index === undefined) {
      throw new TypeError(`Unknown index: ${request.index}`);
    }
    const candidates = [...state.rows.values()]
      .map((tuple) => {
        const row = decodeRow(state, tuple);
        const key =
          index === undefined
            ? rowKey(state, row)
            : index.columnIndexes.map((position) => tuple[position]);
        return { key, tuple };
      })
      .filter(({ key }) => {
        if (request.type === "index" && request.key !== undefined) {
          return compareStorageKeys(key, request.key) === 0;
        }
        return (
          request.range === undefined || storageKeyInRange(key, request.range)
        );
      })
      .sort((left, right) => compareStorageKeys(left.key, right.key));
    if (request.range?.reverse === true) candidates.reverse();
    const tuples = candidates
      .slice(0, request.range?.limit)
      .map((candidate) => candidate.tuple);

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
  #nextCommit = 1;
  readonly #commits = new Map<CommitId, StorageState>();
  readonly #branches = new Map<
    BranchName,
    { head: CommitId; sequence: BranchSequence }
  >();
  readonly #history: CommitBatch[] = [];
  readonly #subscribers = new Set<{
    branch: BranchName;
    after: BranchSequence;
    queue: CommitBatch[];
    wake?: () => void;
  }>();

  constructor(genesis: StorageState) {
    this.#commits.set(genesis.commit, genesis);
    this.#branches.set("main", {
      head: genesis.commit,
      sequence: genesis.sequence,
    });
  }

  async snapshot(selector?: SnapshotSelector): Promise<StorageSnapshot> {
    this.assertOpen();
    if (selector !== undefined && "commit" in selector) {
      const state = this.#commits.get(selector.commit);
      if (state === undefined) {
        throw new TypeError(`Unknown commit: ${selector.commit}`);
      }
      return new MemorySnapshot(state);
    }

    const branch = selector?.branch ?? "main";
    const value = this.#branches.get(branch);
    if (value === undefined) throw new TypeError(`Unknown branch: ${branch}`);
    const state = this.#commits.get(value.head);
    if (state === undefined) throw new Error(`Missing commit: ${value.head}`);
    return new MemorySnapshot(state, branch, value.sequence);
  }

  async head(branch = "main"): Promise<CommitId> {
    this.assertOpen();
    const value = this.#branches.get(branch);
    if (value === undefined) throw new TypeError(`Unknown branch: ${branch}`);
    return value.head;
  }

  async createBranch(request: {
    name: BranchName;
    from: CommitId;
  }): Promise<void> {
    this.assertOpen();
    if (this.#branches.has(request.name)) {
      throw new TypeError(`Branch already exists: ${request.name}`);
    }
    if (!this.#commits.has(request.from)) {
      throw new TypeError(`Unknown commit: ${request.from}`);
    }
    this.#branches.set(request.name, { head: request.from, sequence: 0 });
  }

  async commit(request: CommitRequest): Promise<CommitBatch> {
    this.assertOpen();
    const branch = request.branch ?? "main";
    const currentBranch = this.#branches.get(branch);
    if (currentBranch === undefined) {
      throw new TypeError(`Unknown branch: ${branch}`);
    }
    if (
      request.expectedHead !== undefined &&
      request.expectedHead !== currentBranch.head
    ) {
      throw new StorageConflictError(request.expectedHead, currentBranch.head);
    }
    if (
      request.expectedHead === undefined &&
      request.expectedVersion !== currentBranch.sequence
    ) {
      throw new StorageConflictError(
        request.expectedVersion ?? -1,
        currentBranch.sequence,
      );
    }

    const parentState = this.#commits.get(currentBranch.head);
    if (parentState === undefined) {
      throw new Error(`Missing commit: ${currentBranch.head}`);
    }
    const tables = new Map(parentState.tables);
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

    const sequence = currentBranch.sequence + 1;
    const commitId = `memory:${this.#nextCommit++}`;
    const state = Object.freeze({ commit: commitId, sequence, tables });
    this.#commits.set(commitId, state);
    this.#branches.set(branch, { head: commitId, sequence });
    const commit = Object.freeze({
      commit: commitId,
      branch,
      sequence,
      parent: currentBranch.head,
      version: sequence,
      changes: Object.freeze(changes),
    });
    this.#history.push(commit);
    for (const subscriber of this.#subscribers) {
      if (subscriber.branch !== branch || sequence <= subscriber.after) {
        continue;
      }
      subscriber.queue.push(commit);
      subscriber.after = sequence;
      subscriber.wake?.();
      subscriber.wake = undefined;
    }
    return commit;
  }

  async *changes(options: ChangeStreamOptions): AsyncIterable<CommitBatch> {
    this.assertOpen();
    const branch = options.branch ?? "main";
    if (!this.#branches.has(branch)) {
      throw new TypeError(`Unknown branch: ${branch}`);
    }
    const queue = this.#history.filter(
      (commit) => commit.branch === branch && commit.sequence > options.after,
    );
    const subscriber = {
      branch,
      after: queue.at(-1)?.sequence ?? options.after,
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

  return new MemoryStorage(
    Object.freeze({ commit: "memory:genesis", sequence: 0, tables }),
  );
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
