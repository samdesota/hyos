import { DifferentialQuery } from "./dataflow.js";
import { getQueryTables, type InferQueryResult, type Query } from "./query.js";
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
  type StorageSnapshot,
} from "./storage.js";

type StoredRow = Readonly<Record<string, unknown>>;

function keyForRow(table: AnyTable, row: StoredRow): StorageKey {
  return Object.entries(getTableDefinition(table).columns)
    .filter(([, column]) => getColumnDefinition(column).primaryKey)
    .map(([name]) => row[name]);
}

export class SubscriptionRuntime<QueryValue extends Query<any>> {
  readonly ready: Promise<void>;
  readonly #tables: ReadonlySet<string>;
  #query?: DifferentialQuery<QueryValue>;
  #snapshot?: StorageSnapshot;
  #buffer: CommitBatch[] = [];
  #lastSequence = -1;
  #disposed = false;

  constructor(
    private readonly schema: AnySchema,
    private readonly storage: StorageDatabase,
    private readonly queryValue: QueryValue,
    private readonly listener: (result: InferQueryResult<QueryValue>) => void,
  ) {
    this.#tables = getQueryTables(queryValue);
    this.ready = this.bootstrap();
  }

  accept(commit: CommitBatch): void {
    if (this.#disposed || commit.sequence <= this.#lastSequence) return;
    if (this.#query === undefined) {
      this.#buffer.push(commit);
      return;
    }
    this.apply(commit);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#buffer = [];
    this.#query?.dispose();
    void this.releaseSnapshot();
  }

  private async bootstrap(): Promise<void> {
    const snapshot = await this.storage.snapshot();
    this.#snapshot = snapshot;
    const rowsByTable = new Map<string, Map<string, StoredRow>>();
    try {
      const schemaTables = Object.values(
        getSchemaDefinition(this.schema).tables,
      );
      for (const name of this.#tables) {
        if (this.#disposed) return;
        const table = schemaTables.find(
          (candidate) => getTableDefinition(candidate).name === name,
        );
        if (table === undefined) throw new TypeError(`Unknown table: ${name}`);
        const rows = new Map<string, StoredRow>();
        for await (const batch of snapshot.scan({ type: "table", table })) {
          if (this.#disposed) return;
          for (const row of batch) {
            rows.set(encodeStorageKey(keyForRow(table, row)), row);
          }
        }
        rowsByTable.set(name, rows);
      }

      if (this.#disposed) return;
      const query = new DifferentialQuery(
        this.queryValue,
        rowsByTable,
        this.listener,
      );
      this.#query = query;
      this.#lastSequence = snapshot.sequence;
      const buffered = this.#buffer;
      this.#buffer = [];
      for (const commit of buffered) this.apply(commit);
    } finally {
      await this.releaseSnapshot();
    }
  }

  private apply(commit: CommitBatch): void {
    if (commit.sequence <= this.#lastSequence) return;
    if (
      commit.changes.some((change) => {
        const name = getTableDefinition(change.table).name;
        return this.#tables.has(name);
      })
    ) {
      this.#query?.apply(commit);
    }
    this.#lastSequence = commit.sequence;
  }

  private async releaseSnapshot(): Promise<void> {
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return;
    this.#snapshot = undefined;
    await snapshot.close();
  }
}
