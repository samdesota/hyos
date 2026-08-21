import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  getColumnDefinition,
  getIndexDefinition,
  getSchemaDefinition,
  getTableDefinition,
  type AnySchema,
  type AnyTable,
  type InferRow,
} from "../schema.js";
import {
  StorageConflictError,
  type BranchName,
  type BranchSequence,
  type ChangeStreamOptions,
  type CommitBatch,
  type CommitId,
  type CommitRequest,
  type CommittedChange,
  type SnapshotSelector,
  type StorageDatabase,
  type StorageKey,
  type StorageScan,
  type StorageSnapshot,
} from "../storage.js";
import {
  ImmutableBPlusTree,
  type TreeRange,
  type TreeRoot,
} from "./bplus-tree.js";
import {
  decodeValue,
  encodeOrderedKey,
  encodeValue,
  keyPrefixUpperBound,
} from "./codec.js";
import { AppendOnlyPageStore } from "./page-store.js";

type StoredRow = Readonly<Record<string, unknown>>;

function decodeRow(bytes: Uint8Array): StoredRow {
  return Object.freeze(decodeValue(bytes) as Record<string, unknown>);
}

function cloneRow(row: Readonly<Record<string, unknown>>): StoredRow {
  return decodeRow(encodeValue(row));
}

type TableManifest = {
  primary: TreeRoot;
  indexes: Record<string, TreeRoot>;
};

type DatabaseManifest = {
  schema: string;
  tables: Record<string, TableManifest>;
};

type StoredChange = {
  table: string;
  key: StorageKey;
  before?: StoredRow;
  after?: StoredRow;
};

type StoredCommit = {
  parent: CommitId | null;
  branch: BranchName;
  sequence: BranchSequence;
  manifest: DatabaseManifest;
  changes: StoredChange[];
};

type StoredRef = {
  operation: "create" | "commit";
  branch: BranchName;
  head: CommitId;
  sequence: BranchSequence;
};

type BranchState = { head: CommitId; sequence: BranchSequence };

type TableMetadata = Readonly<{
  table: AnyTable;
  name: string;
  primaryColumns: readonly string[];
  indexes: readonly Readonly<{
    name: string;
    unique: boolean;
    columns: readonly string[];
  }>[];
}>;

function commitId(offset: number): CommitId {
  return `commit:${offset}`;
}

function commitOffset(id: CommitId): number {
  if (!id.startsWith("commit:"))
    throw new TypeError(`Invalid commit ID: ${id}`);
  const offset = Number(id.slice("commit:".length));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError(`Invalid commit ID: ${id}`);
  }
  return offset;
}

function cloneManifest(manifest: DatabaseManifest): DatabaseManifest {
  return {
    schema: manifest.schema,
    tables: Object.fromEntries(
      Object.entries(manifest.tables).map(([name, table]) => [
        name,
        { primary: table.primary, indexes: { ...table.indexes } },
      ]),
    ),
  };
}

function schemaMetadata(schema: AnySchema): {
  fingerprint: string;
  tables: ReadonlyMap<string, TableMetadata>;
} {
  const tables = new Map<string, TableMetadata>();
  const description = Object.values(getSchemaDefinition(schema).tables)
    .map((table) => {
      const definition = getTableDefinition(table);
      const columns = Object.entries(definition.columns).map(
        ([name, column]) => {
          const value = getColumnDefinition(column);
          return {
            name,
            dataType: value.dataType,
            notNull: value.notNull,
            primaryKey: value.primaryKey,
          };
        },
      );
      const indexes = definition.indexes.map((value) => {
        const index = getIndexDefinition(value);
        return {
          name: index.name,
          unique: index.unique,
          columns: index.columns.map(
            (column) => getColumnDefinition(column).name,
          ),
        };
      });
      tables.set(definition.name, {
        table,
        name: definition.name,
        primaryColumns: columns
          .filter((column) => column.primaryKey)
          .map((column) => column.name),
        indexes,
      });
      return { name: definition.name, columns, indexes };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    fingerprint: createHash("sha256")
      .update(JSON.stringify(description))
      .digest("hex"),
    tables,
  };
}

function primaryKey(metadata: TableMetadata, row: StoredRow): StorageKey {
  return metadata.primaryColumns.map((column) => row[column]);
}

function indexPrefix(
  index: TableMetadata["indexes"][number],
  row: StoredRow,
): StorageKey {
  return index.columns.map((column) => row[column]);
}

function indexKey(
  index: TableMetadata["indexes"][number],
  row: StoredRow,
  key: StorageKey,
): Uint8Array {
  return encodeOrderedKey([...indexPrefix(index, row), ...key]);
}

function encodedRange(
  range: StorageScan["range"],
  prefixValues: boolean,
): TreeRange {
  if (range === undefined) return {};
  return {
    ...(range.gt === undefined
      ? {}
      : {
          ...(prefixValues
            ? { gte: keyPrefixUpperBound(encodeOrderedKey(range.gt)) }
            : { gt: encodeOrderedKey(range.gt) }),
        }),
    ...(range.gte === undefined ? {} : { gte: encodeOrderedKey(range.gte) }),
    ...(range.lt === undefined ? {} : { lt: encodeOrderedKey(range.lt) }),
    ...(range.lte === undefined
      ? {}
      : {
          ...(prefixValues
            ? { lt: keyPrefixUpperBound(encodeOrderedKey(range.lte)) }
            : { lte: encodeOrderedKey(range.lte) }),
        }),
    reverse: range.reverse,
    limit: range.limit,
  };
}

class NodeSnapshot implements StorageSnapshot {
  readonly version: BranchSequence;
  #closed = false;

  constructor(
    readonly commit: CommitId,
    readonly sequence: BranchSequence,
    readonly branch: BranchName | undefined,
    private readonly manifest: DatabaseManifest,
    private readonly tree: ImmutableBPlusTree,
    private readonly tables: ReadonlyMap<string, TableMetadata>,
  ) {
    this.version = sequence;
  }

  async get<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): Promise<InferRow<TableValue> | undefined> {
    this.assertOpen();
    const name = getTableDefinition(table).name;
    const root = this.manifest.tables[name]?.primary;
    if (root === undefined) throw new TypeError(`Unknown table: ${name}`);
    const value = await this.tree.get(root, encodeOrderedKey(key));
    return (value === undefined ? undefined : decodeRow(value)) as
      InferRow<TableValue> | undefined;
  }

  async *scan<TableValue extends AnyTable>(
    request: StorageScan<TableValue>,
  ): AsyncIterable<readonly InferRow<TableValue>[]> {
    this.assertOpen();
    const name = getTableDefinition(request.table).name;
    const table = this.manifest.tables[name];
    const metadata = this.tables.get(name);
    if (table === undefined || metadata === undefined) {
      throw new TypeError(`Unknown table: ${name}`);
    }

    const rows: InferRow<TableValue>[] = [];
    const emit = async function* (): AsyncIterable<
      readonly InferRow<TableValue>[]
    > {
      if (rows.length > 0) {
        yield Object.freeze(rows.splice(0, rows.length));
      }
    };

    if (request.type === "table") {
      for await (const entry of this.tree.scan(
        table.primary,
        encodedRange(request.range, false),
      )) {
        rows.push(decodeRow(entry.value) as InferRow<TableValue>);
        if (rows.length === 1_024) yield* emit();
      }
    } else {
      const index = metadata.indexes.find(
        (value) => value.name === request.index,
      );
      if (index === undefined)
        throw new TypeError(`Unknown index: ${request.index}`);
      const root = table.indexes[index.name];
      const range =
        request.key === undefined
          ? encodedRange(request.range, true)
          : {
              gte: encodeOrderedKey(request.key),
              lt: keyPrefixUpperBound(encodeOrderedKey(request.key)),
              reverse: request.range?.reverse,
              limit: request.range?.limit,
            };
      for await (const entry of this.tree.scan(root, range)) {
        const key = decodeValue(entry.value) as StorageKey;
        const value = await this.tree.get(table.primary, encodeOrderedKey(key));
        if (value !== undefined)
          rows.push(decodeRow(value) as InferRow<TableValue>);
        if (rows.length === 1_024) yield* emit();
      }
    }
    yield* emit();
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Storage snapshot is closed");
  }
}

export class NodeStorageDatabase implements StorageDatabase {
  readonly #branches = new Map<BranchName, BranchState>();
  readonly #subscribers = new Set<{
    branch: BranchName;
    after: BranchSequence;
    queue: CommitBatch[];
    wake?: () => void;
  }>();
  #closed = false;
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly store: AppendOnlyPageStore,
    private readonly tree: ImmutableBPlusTree,
    private readonly fingerprint: string,
    private readonly tables: ReadonlyMap<string, TableMetadata>,
  ) {}

  static async open(options: {
    directory: string;
    schema: AnySchema;
    cacheBytes?: number;
    maxEntries?: number;
  }): Promise<NodeStorageDatabase> {
    await mkdir(options.directory, { recursive: true });
    const metadata = schemaMetadata(options.schema);
    const store = await AppendOnlyPageStore.open(
      join(options.directory, "hydb.data"),
    );
    const database = new NodeStorageDatabase(
      store,
      new ImmutableBPlusTree(store, options),
      metadata.fingerprint,
      metadata.tables,
    );
    try {
      await database.load();
      return database;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  cacheStats() {
    return this.tree.cacheStats();
  }

  reclaimCache(bytes: number): number {
    return this.tree.reclaimCache(bytes);
  }

  setCacheLimit(bytes: number): void {
    this.tree.setCacheLimit(bytes);
  }

  async snapshot(selector?: SnapshotSelector): Promise<StorageSnapshot> {
    this.assertOpen();
    let id: CommitId;
    let branch: BranchName | undefined;
    let sequence: BranchSequence | undefined;
    if (selector !== undefined && "commit" in selector) id = selector.commit;
    else {
      branch = selector?.branch ?? "main";
      const state = this.#branches.get(branch);
      if (state === undefined) throw new TypeError(`Unknown branch: ${branch}`);
      id = state.head;
      sequence = state.sequence;
    }
    const commit = await this.readCommit(id);
    if (commit.manifest.schema !== this.fingerprint) {
      throw new TypeError("Storage schema does not match the supplied schema");
    }
    return new NodeSnapshot(
      id,
      sequence ?? commit.sequence,
      branch,
      commit.manifest,
      this.tree,
      this.tables,
    );
  }

  async head(branch = "main"): Promise<CommitId> {
    this.assertOpen();
    const state = this.#branches.get(branch);
    if (state === undefined) throw new TypeError(`Unknown branch: ${branch}`);
    return state.head;
  }

  async createBranch(request: {
    name: BranchName;
    from: CommitId;
  }): Promise<void> {
    return this.enqueueWrite(async () => {
      if (this.#branches.has(request.name)) {
        throw new TypeError(`Branch already exists: ${request.name}`);
      }
      await this.readCommit(request.from);
      const ref: StoredRef = {
        operation: "create",
        branch: request.name,
        head: request.from,
        sequence: 0,
      };
      await this.store.append("ref", encodeValue(ref));
      await this.store.sync();
      this.#branches.set(request.name, { head: request.from, sequence: 0 });
    });
  }

  async commit(request: CommitRequest): Promise<CommitBatch> {
    let result: CommitBatch | undefined;
    await this.enqueueWrite(async () => {
      result = await this.commitNow(request);
    });
    return result!;
  }

  async *changes(options: ChangeStreamOptions): AsyncIterable<CommitBatch> {
    this.assertOpen();
    const branch = options.branch ?? "main";
    const branchState = this.#branches.get(branch);
    if (branchState === undefined)
      throw new TypeError(`Unknown branch: ${branch}`);
    const through = branchState.sequence;
    const subscriber = {
      branch,
      after: through,
      queue: [] as CommitBatch[],
      wake: undefined as (() => void) | undefined,
    };
    const wakeOnAbort = () => subscriber.wake?.();
    options.signal?.addEventListener("abort", wakeOnAbort, { once: true });
    this.#subscribers.add(subscriber);
    try {
      for await (const commit of this.readChanges(
        branch,
        options.after,
        through,
      )) {
        if (options.signal?.aborted === true) return;
        yield commit;
      }
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
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of this.#subscribers) subscriber.wake?.();
    await this.#writeQueue;
    await this.store.close();
  }

  private async load(): Promise<void> {
    for await (const record of this.store.records(new Set(["ref"]))) {
      const ref = decodeValue(record.payload) as StoredRef;
      this.#branches.set(ref.branch, {
        head: ref.head,
        sequence: ref.sequence,
      });
    }
    if (this.#branches.size === 0) await this.initialize();
    const main = this.#branches.get("main");
    if (main === undefined) throw new Error("Storage has no main branch");
    const head = await this.readCommit(main.head);
    if (head.manifest.schema !== this.fingerprint) {
      throw new TypeError("Storage schema does not match the supplied schema");
    }
  }

  private async initialize(): Promise<void> {
    const manifest: DatabaseManifest = {
      schema: this.fingerprint,
      tables: Object.fromEntries(
        [...this.tables.values()].map((table) => [
          table.name,
          {
            primary: null,
            indexes: Object.fromEntries(
              table.indexes.map((index) => [index.name, null]),
            ),
          },
        ]),
      ),
    };
    const stored: StoredCommit = {
      parent: null,
      branch: "main",
      sequence: 0,
      manifest,
      changes: [],
    };
    const offset = await this.store.append("commit", encodeValue(stored));
    const head = commitId(offset);
    const ref: StoredRef = {
      operation: "create",
      branch: "main",
      head,
      sequence: 0,
    };
    await this.store.append("ref", encodeValue(ref));
    await this.store.sync();
    this.#branches.set("main", { head, sequence: 0 });
  }

  private async commitNow(request: CommitRequest): Promise<CommitBatch> {
    this.assertOpen();
    const branch = request.branch ?? "main";
    const current = this.#branches.get(branch);
    if (current === undefined) throw new TypeError(`Unknown branch: ${branch}`);
    if (
      request.expectedHead !== undefined &&
      request.expectedHead !== current.head
    ) {
      throw new StorageConflictError(request.expectedHead, current.head);
    }
    if (
      request.expectedHead === undefined &&
      request.expectedVersion !== current.sequence
    ) {
      throw new StorageConflictError(
        request.expectedVersion ?? -1,
        current.sequence,
      );
    }

    const parent = await this.readCommit(current.head);
    const manifest = cloneManifest(parent.manifest);
    const changes: StoredChange[] = [];

    for (const mutation of request.mutations) {
      const name = getTableDefinition(mutation.table).name;
      const metadata = this.tables.get(name);
      const table = manifest.tables[name];
      if (metadata === undefined || table === undefined) {
        throw new TypeError(`Unknown table: ${name}`);
      }
      const key =
        mutation.type === "insert"
          ? primaryKey(metadata, mutation.row)
          : mutation.key;
      const encodedKey = encodeOrderedKey(key);
      const beforeBytes = await this.tree.get(table.primary, encodedKey);
      const before =
        beforeBytes === undefined ? undefined : decodeRow(beforeBytes);
      let after: StoredRow | undefined;

      if (mutation.type === "insert") {
        if (before !== undefined)
          throw new TypeError(`Duplicate primary key for table ${name}`);
        after = cloneRow(mutation.row);
      } else {
        if (before === undefined)
          throw new TypeError(`Missing row for table ${name}`);
        if (mutation.type === "update") {
          if (
            Buffer.compare(
              encodeOrderedKey(primaryKey(metadata, mutation.row)),
              encodedKey,
            ) !== 0
          ) {
            throw new TypeError(
              `Primary keys cannot be updated for table ${name}`,
            );
          }
          after = cloneRow(mutation.row);
        }
      }

      for (const index of metadata.indexes) {
        let root = table.indexes[index.name] ?? null;
        if (before !== undefined) {
          root = await this.tree.mutate(root, [
            { type: "delete", key: indexKey(index, before, key) },
          ]);
        }
        if (after !== undefined) {
          if (index.unique) {
            const prefix = encodeOrderedKey(indexPrefix(index, after));
            for await (const existing of this.tree.scan(root, {
              gte: prefix,
              lt: keyPrefixUpperBound(prefix),
              limit: 1,
            })) {
              if (existing !== undefined) {
                throw new TypeError(
                  `Unique index ${index.name} rejected a duplicate key`,
                );
              }
            }
          }
          root = await this.tree.mutate(root, [
            {
              type: "put",
              key: indexKey(index, after, key),
              value: encodeValue(key),
            },
          ]);
        }
        table.indexes[index.name] = root;
      }

      table.primary = await this.tree.mutate(table.primary, [
        after === undefined
          ? { type: "delete", key: encodedKey }
          : { type: "put", key: encodedKey, value: encodeValue(after) },
      ]);
      changes.push({
        table: name,
        key: [...key],
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      });
    }

    const stored: StoredCommit = {
      parent: current.head,
      branch,
      sequence: current.sequence + 1,
      manifest,
      changes,
    };
    const offset = await this.store.append("commit", encodeValue(stored));
    const id = commitId(offset);
    const ref: StoredRef = {
      operation: "commit",
      branch,
      head: id,
      sequence: stored.sequence,
    };
    await this.store.append("ref", encodeValue(ref));
    await this.store.sync();
    this.#branches.set(branch, { head: id, sequence: stored.sequence });
    const batch = this.toCommitBatch(id, stored);
    for (const subscriber of this.#subscribers) {
      if (subscriber.branch !== branch || stored.sequence <= subscriber.after)
        continue;
      subscriber.queue.push(batch);
      subscriber.after = stored.sequence;
      subscriber.wake?.();
      subscriber.wake = undefined;
    }
    return batch;
  }

  private async readCommit(id: CommitId): Promise<StoredCommit> {
    const record = await this.store.read(commitOffset(id), "commit");
    return decodeValue(record.payload) as StoredCommit;
  }

  private async *readChanges(
    branch: BranchName,
    after: BranchSequence,
    through: BranchSequence,
  ): AsyncIterable<CommitBatch> {
    for await (const record of this.store.records(new Set(["ref"]))) {
      const ref = decodeValue(record.payload) as StoredRef;
      if (
        ref.operation !== "commit" ||
        ref.branch !== branch ||
        ref.sequence <= after ||
        ref.sequence > through
      ) {
        continue;
      }
      yield this.toCommitBatch(ref.head, await this.readCommit(ref.head));
    }
  }

  private toCommitBatch(id: CommitId, stored: StoredCommit): CommitBatch {
    const changes: CommittedChange[] = stored.changes.map((change) => {
      const metadata = this.tables.get(change.table);
      if (metadata === undefined)
        throw new TypeError(`Unknown table: ${change.table}`);
      return Object.freeze({
        table: metadata.table,
        key: Object.freeze([...change.key]),
        ...(change.before === undefined
          ? {}
          : { before: Object.freeze(change.before) }),
        ...(change.after === undefined
          ? {}
          : { after: Object.freeze(change.after) }),
      });
    });
    return Object.freeze({
      commit: id,
      branch: stored.branch,
      sequence: stored.sequence,
      parent: stored.parent!,
      version: stored.sequence,
      changes: Object.freeze(changes),
    });
  }

  private enqueueWrite<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.#writeQueue.then(operation);
    this.#writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Storage database is closed");
  }
}

export async function openNodeStorage(options: {
  directory: string;
  schema: AnySchema;
  cacheBytes?: number;
  maxEntries?: number;
}): Promise<NodeStorageDatabase> {
  return NodeStorageDatabase.open(options);
}
