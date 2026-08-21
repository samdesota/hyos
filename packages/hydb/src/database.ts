import {
  evaluateQuery,
  getQueryTables,
  type InferQueryResult,
  type Query,
  type QueryDataSource,
} from "./query.js";
import {
  getColumnDefinition,
  getSchemaDefinition,
  getTableDefinition,
  type AnySchema,
  type AnyTable,
} from "./schema.js";
import {
  encodeStorageKey,
  type CommitBatch,
  type StorageDatabase,
  type StorageKey,
} from "./storage.js";

type StoredRow = Readonly<Record<string, unknown>>;

export interface Database {
  fetch<QueryValue extends Query<any>>(
    query: QueryValue,
  ): Promise<InferQueryResult<QueryValue>>;

  subscribe<QueryValue extends Query<any>>(
    query: QueryValue,
    listener: (result: InferQueryResult<QueryValue>) => void,
  ): () => void;

  close(): Promise<void>;
}

class QueryDatabase implements Database, QueryDataSource {
  readonly #abortController = new AbortController();
  readonly #subscriptions = new Set<{
    query: Query<any>;
    tables: ReadonlySet<string>;
    listener: (result: any) => void;
    result: any;
  }>();
  readonly #arrangements = new Map<
    string,
    Map<string, Map<string, Set<string>>>
  >();
  #changeLoop?: Promise<void>;

  constructor(
    private readonly storage: StorageDatabase,
    private readonly tables: ReadonlyMap<string, Map<string, StoredRow>>,
  ) {}

  rows(table: string): readonly StoredRow[] {
    const rows = this.tables.get(table);
    if (rows === undefined) throw new TypeError(`Unknown table: ${table}`);
    return [...rows.values()];
  }

  lookup(
    table: string,
    column: string,
    value: unknown,
  ): readonly StoredRow[] | undefined {
    if (value === undefined) return [];
    const rows = this.tables.get(table);
    if (rows === undefined) return undefined;

    let tableArrangements = this.#arrangements.get(table);
    if (tableArrangements === undefined) {
      tableArrangements = new Map();
      this.#arrangements.set(table, tableArrangements);
    }

    let arrangement = tableArrangements.get(column);
    if (arrangement === undefined) {
      arrangement = new Map();
      for (const [primaryKey, row] of rows) {
        const key = encodeArrangementKey(row[column]);
        if (key === undefined) continue;
        const bucket = arrangement.get(key) ?? new Set<string>();
        bucket.add(primaryKey);
        arrangement.set(key, bucket);
      }
      tableArrangements.set(column, arrangement);
    }

    const key = encodeArrangementKey(value);
    if (key === undefined) return [];
    return [...(arrangement.get(key) ?? [])]
      .map((primaryKey) => rows.get(primaryKey))
      .filter((row): row is StoredRow => row !== undefined);
  }

  async fetch<QueryValue extends Query<any>>(
    query: QueryValue,
  ): Promise<InferQueryResult<QueryValue>> {
    return evaluateQuery(query, this);
  }

  subscribe<QueryValue extends Query<any>>(
    query: QueryValue,
    listener: (result: InferQueryResult<QueryValue>) => void,
  ): () => void {
    const result = evaluateQuery(query, this);
    const subscription = {
      query,
      tables: getQueryTables(query),
      listener,
      result,
    };
    this.#subscriptions.add(subscription);
    listener(result);
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  start(after: number): void {
    this.#changeLoop = this.consumeChanges(after);
  }

  async close(): Promise<void> {
    this.#abortController.abort();
    try {
      await this.#changeLoop;
    } finally {
      await this.storage.close();
    }
  }

  private async consumeChanges(after: number): Promise<void> {
    for await (const commit of this.storage.changes({
      after,
      signal: this.#abortController.signal,
    })) {
      this.applyCommit(commit);
    }
  }

  private applyCommit(commit: CommitBatch): void {
    const changedTables = new Set<string>();
    for (const change of commit.changes) {
      const name = getTableDefinition(change.table).name;
      const rows = this.tables.get(name);
      if (rows === undefined) throw new TypeError(`Unknown table: ${name}`);
      const key = encodeStorageKey(change.key);
      this.updateArrangements(name, key, change.before, change.after);
      if (change.after === undefined) rows.delete(key);
      else rows.set(key, change.after);
      changedTables.add(name);
    }

    for (const subscription of [...this.#subscriptions]) {
      if (![...subscription.tables].some((table) => changedTables.has(table))) {
        continue;
      }
      const result = evaluateQuery(subscription.query, this);
      if (deepEqual(result, subscription.result)) continue;
      subscription.result = result;
      subscription.listener(result);
    }
  }

  private updateArrangements(
    table: string,
    primaryKey: string,
    before: StoredRow | undefined,
    after: StoredRow | undefined,
  ): void {
    const arrangements = this.#arrangements.get(table);
    if (arrangements === undefined) return;

    for (const [column, arrangement] of arrangements) {
      if (before !== undefined) {
        const key = encodeArrangementKey(before[column]);
        const bucket = key === undefined ? undefined : arrangement.get(key);
        if (key !== undefined && bucket !== undefined) {
          bucket.delete(primaryKey);
          if (bucket.size === 0) arrangement.delete(key);
        }
      }
      if (after !== undefined) {
        const key = encodeArrangementKey(after[column]);
        if (key !== undefined) {
          const bucket = arrangement.get(key) ?? new Set<string>();
          bucket.add(primaryKey);
          arrangement.set(key, bucket);
        }
      }
    }
  }
}

function encodeArrangementKey(value: unknown): string | undefined {
  try {
    return encodeStorageKey([value]);
  } catch {
    return undefined;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null
  ) {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(([key, value]) =>
        deepEqual(value, (right as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

function keyForRow(table: AnyTable, row: StoredRow): StorageKey {
  return Object.entries(getTableDefinition(table).columns)
    .filter(([, column]) => getColumnDefinition(column).primaryKey)
    .map(([name]) => row[name]);
}

export async function database(options: {
  schema: AnySchema;
  storage: StorageDatabase;
}): Promise<Database> {
  const snapshot = await options.storage.snapshot();
  const tables = new Map<string, Map<string, StoredRow>>();

  try {
    for (const table of Object.values(
      getSchemaDefinition(options.schema).tables,
    )) {
      const rows = new Map<string, StoredRow>();
      for await (const batch of snapshot.scan({ type: "table", table })) {
        for (const row of batch) {
          rows.set(encodeStorageKey(keyForRow(table, row)), row);
        }
      }
      tables.set(getTableDefinition(table).name, rows);
    }
  } finally {
    await snapshot.close();
  }

  const queryDatabase = new QueryDatabase(options.storage, tables);
  queryDatabase.start(snapshot.version);
  return queryDatabase;
}
