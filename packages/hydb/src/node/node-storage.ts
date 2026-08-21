import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MemoryManager } from "../memory.js";

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
  HistoryUnavailableError,
  StorageConflictError,
  type BranchName,
  type BranchSequence,
  type ChangeStreamOptions,
  type CommitBatch,
  type CommitId,
  type CommitRequest,
  type CommittedChange,
  type GarbageCollectionReport,
  type RetentionPolicy,
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
  id?: CommitId;
  committedAtMs?: number;
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

type StoredMetadata = {
  format: 2;
  retention: RetentionPolicy;
  retains?: Record<string, CommitId>;
  historyFloors?: Record<BranchName, BranchSequence>;
};

const foreverRetention: RetentionPolicy = Object.freeze({ mode: "forever" });

function validateRetention(policy: RetentionPolicy): RetentionPolicy {
  if (policy.mode === "forever") return foreverRetention;
  if (!Number.isSafeInteger(policy.keepAtLeast) || policy.keepAtLeast < 1) {
    throw new TypeError("retention.keepAtLeast must be a positive integer");
  }
  if (
    policy.keepYoungerThanMs !== undefined &&
    (!Number.isFinite(policy.keepYoungerThanMs) ||
      policy.keepYoungerThanMs <= 0)
  ) {
    throw new TypeError("retention.keepYoungerThanMs must be positive");
  }
  return Object.freeze({
    mode: "window",
    keepAtLeast: policy.keepAtLeast,
    ...(policy.keepYoungerThanMs === undefined
      ? {}
      : { keepYoungerThanMs: policy.keepYoungerThanMs }),
  });
}

function sameRetention(left: RetentionPolicy, right: RetentionPolicy): boolean {
  return (
    left.mode === right.mode &&
    (left.mode === "forever" ||
      (right.mode === "window" &&
        left.keepAtLeast === right.keepAtLeast &&
        left.keepYoungerThanMs === right.keepYoungerThanMs))
  );
}

async function syncParentDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

type BranchState = {
  head: CommitId;
  sequence: BranchSequence;
  base: CommitId;
};

type StorageGeneration = {
  store: AppendOnlyPageStore;
  tree: ImmutableBPlusTree;
  leases: number;
  retired: boolean;
  closed: boolean;
};

type CommitLocation = Readonly<{
  offset: number;
  value: StoredCommit;
}>;

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

const newCommitId = (): CommitId => `commit:${randomUUID()}`;

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
    private readonly release: () => Promise<void>,
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
    if (this.#closed) return;
    this.#closed = true;
    await this.release();
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
    retainAfter: BranchSequence;
    queue: CommitBatch[];
    wake?: () => void;
  }>();
  #closed = false;
  #writeQueue: Promise<void> = Promise.resolve();
  #collectionBarrier: Promise<void> | undefined;
  #retention: RetentionPolicy = foreverRetention;
  #metadataFound = false;
  readonly #retains = new Map<string, CommitId>();
  readonly #historyFloors = new Map<BranchName, BranchSequence>();
  readonly #snapshotPins = new Map<CommitId, number>();
  readonly #commits = new Map<CommitId, CommitLocation>();
  readonly #generations = new Set<StorageGeneration>();
  #generation: StorageGeneration;

  private constructor(
    generation: StorageGeneration,
    private readonly dataPath: string,
    private readonly treeOptions: {
      cacheBytes?: number;
      maxEntries?: number;
      memory?: MemoryManager;
    },
    private readonly fingerprint: string,
    private readonly tables: ReadonlyMap<string, TableMetadata>,
    private readonly requestedRetention: RetentionPolicy | undefined,
  ) {
    this.#generation = generation;
    this.#generations.add(generation);
  }

  private get store(): AppendOnlyPageStore {
    return this.#generation.store;
  }

  private get tree(): ImmutableBPlusTree {
    return this.#generation.tree;
  }

  static async open(options: NodeStorageOptions): Promise<NodeStorageDatabase> {
    const requestedRetention =
      options.retention === undefined
        ? undefined
        : validateRetention(options.retention);
    await mkdir(options.directory, { recursive: true });
    const metadata = schemaMetadata(options.schema);
    const dataPath = join(options.directory, "hydb.data");
    const store = await AppendOnlyPageStore.open(dataPath);
    const treeOptions = {
      cacheBytes: options.cacheBytes,
      maxEntries: options.maxEntries,
      memory: options.memory,
    };
    const tree = new ImmutableBPlusTree(store, treeOptions);
    const database = new NodeStorageDatabase(
      { store, tree, leases: 1, retired: false, closed: false },
      dataPath,
      treeOptions,
      metadata.fingerprint,
      metadata.tables,
      requestedRetention,
    );
    try {
      await database.load();
      return database;
    } catch (error) {
      tree.dispose();
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
    const collection = this.#collectionBarrier;
    if (collection !== undefined) await collection;
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
    const generation = this.#generation;
    generation.leases += 1;
    this.#snapshotPins.set(id, (this.#snapshotPins.get(id) ?? 0) + 1);
    let commit: StoredCommit;
    try {
      commit = await this.readCommit(id);
    } catch (error) {
      await this.releaseSnapshot(generation, id);
      throw error;
    }
    if (commit.manifest.schema !== this.fingerprint) {
      await this.releaseSnapshot(generation, id);
      throw new TypeError("Storage schema does not match the supplied schema");
    }
    return new NodeSnapshot(
      id,
      sequence ?? commit.sequence,
      branch,
      commit.manifest,
      generation.tree,
      this.tables,
      () => this.releaseSnapshot(generation, id),
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
      this.#branches.set(request.name, {
        head: request.from,
        sequence: 0,
        base: request.from,
      });
    });
  }

  async commit(request: CommitRequest): Promise<CommitBatch> {
    let result: CommitBatch | undefined;
    await this.enqueueWrite(async () => {
      result = await this.commitNow(request);
    });
    return result!;
  }

  async retain(request: { name: string; commit: CommitId }): Promise<void> {
    return this.enqueueWrite(async () => {
      this.assertOpen();
      if (request.name.trim().length === 0) {
        throw new TypeError("Retention name cannot be empty");
      }
      await this.readCommit(request.commit);
      const current = this.#retains.get(request.name);
      if (current !== undefined && current !== request.commit) {
        throw new TypeError(`Retention already exists: ${request.name}`);
      }
      if (current === request.commit) return;
      this.#retains.set(request.name, request.commit);
      await this.writeMetadata();
      await this.store.sync();
    });
  }

  async releaseRetention(name: string): Promise<void> {
    return this.enqueueWrite(async () => {
      this.assertOpen();
      if (!this.#retains.delete(name)) {
        throw new TypeError(`Unknown retention: ${name}`);
      }
      await this.writeMetadata();
      await this.store.sync();
    });
  }

  collectGarbage(): Promise<GarbageCollectionReport> {
    const operation = this.enqueueWrite(() => this.collectGarbageNow());
    const barrier = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#collectionBarrier = barrier;
    void barrier.then(() => {
      if (this.#collectionBarrier === barrier) {
        this.#collectionBarrier = undefined;
      }
    });
    return operation;
  }

  async *changes(options: ChangeStreamOptions): AsyncIterable<CommitBatch> {
    const collection = this.#collectionBarrier;
    if (collection !== undefined) await collection;
    this.assertOpen();
    const branch = options.branch ?? "main";
    const branchState = this.#branches.get(branch);
    if (branchState === undefined)
      throw new TypeError(`Unknown branch: ${branch}`);
    const historyFloor = this.#historyFloors.get(branch) ?? 0;
    if (options.after < historyFloor) {
      throw new HistoryUnavailableError(undefined, historyFloor);
    }
    const through = branchState.sequence;
    const subscriber = {
      branch,
      after: through,
      retainAfter: options.after,
      queue: [] as CommitBatch[],
      wake: undefined as (() => void) | undefined,
    };
    const replayGeneration = this.#generation;
    replayGeneration.leases += 1;
    const wakeOnAbort = () => subscriber.wake?.();
    options.signal?.addEventListener("abort", wakeOnAbort, { once: true });
    this.#subscribers.add(subscriber);
    try {
      try {
        for await (const commit of this.readChanges(
          replayGeneration,
          branch,
          options.after,
          through,
        )) {
          if (options.signal?.aborted === true) return;
          subscriber.retainAfter = commit.sequence;
          yield commit;
        }
      } finally {
        await this.releaseGeneration(replayGeneration);
      }
      while (!this.#closed && options.signal?.aborted !== true) {
        const commit = subscriber.queue.shift();
        if (commit !== undefined) {
          subscriber.retainAfter = commit.sequence;
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
    await Promise.all(
      [...this.#generations].map((generation) =>
        this.closeGeneration(generation),
      ),
    );
  }

  private async load(): Promise<void> {
    const published = new Set<CommitId>();
    for await (const record of this.store.records(
      new Set(["commit", "ref", "meta"]),
    )) {
      if (record.type === "commit") {
        const stored = decodeValue(record.payload) as StoredCommit;
        const id = stored.id ?? `commit:${record.id}`;
        this.#commits.set(id, { offset: record.id, value: stored });
      } else if (record.type === "meta") {
        const metadata = decodeValue(record.payload) as StoredMetadata;
        if (metadata.format !== 2)
          throw new Error("Unsupported storage format");
        this.#retention = validateRetention(metadata.retention);
        this.#retains.clear();
        for (const [name, commit] of Object.entries(metadata.retains ?? {})) {
          this.#retains.set(name, commit);
        }
        this.#historyFloors.clear();
        for (const [branch, floor] of Object.entries(
          metadata.historyFloors ?? {},
        )) {
          this.#historyFloors.set(branch, floor);
        }
        this.#metadataFound = true;
      } else {
        const ref = decodeValue(record.payload) as StoredRef;
        published.add(ref.head);
        const previous = this.#branches.get(ref.branch);
        this.#branches.set(ref.branch, {
          head: ref.head,
          sequence: ref.sequence,
          base:
            ref.operation === "create"
              ? ref.head
              : (previous?.base ?? ref.head),
        });
      }
    }
    for (const id of this.#commits.keys()) {
      if (!published.has(id)) this.#commits.delete(id);
    }
    if (this.#branches.size === 0) {
      this.#retention = this.requestedRetention ?? foreverRetention;
      await this.initialize();
    } else if (!this.#metadataFound) {
      this.#retention = this.requestedRetention ?? foreverRetention;
      await this.writeMetadata();
      await this.store.sync();
    } else if (
      this.requestedRetention !== undefined &&
      !sameRetention(this.requestedRetention, this.#retention)
    ) {
      throw new TypeError("Configured retention policy does not match storage");
    }
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
      id: newCommitId(),
      committedAtMs: Date.now(),
      parent: null,
      branch: "main",
      sequence: 0,
      manifest,
      changes: [],
    };
    const offset = await this.store.append("commit", encodeValue(stored));
    const head = stored.id!;
    const ref: StoredRef = {
      operation: "create",
      branch: "main",
      head,
      sequence: 0,
    };
    await this.store.append("ref", encodeValue(ref));
    await this.writeMetadata();
    await this.store.sync();
    this.#commits.set(head, { offset, value: stored });
    this.#branches.set("main", { head, sequence: 0, base: head });
  }

  private async writeMetadata(): Promise<void> {
    await this.store.append(
      "meta",
      encodeValue({
        format: 2,
        retention: this.#retention,
        retains: Object.fromEntries(this.#retains),
        historyFloors: Object.fromEntries(this.#historyFloors),
      } satisfies StoredMetadata),
    );
    this.#metadataFound = true;
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
      id: newCommitId(),
      committedAtMs: Date.now(),
      parent: current.head,
      branch,
      sequence: current.sequence + 1,
      manifest,
      changes,
    };
    const offset = await this.store.append("commit", encodeValue(stored));
    const id = stored.id!;
    const ref: StoredRef = {
      operation: "commit",
      branch,
      head: id,
      sequence: stored.sequence,
    };
    await this.store.append("ref", encodeValue(ref));
    await this.store.sync();
    this.#commits.set(id, { offset, value: stored });
    this.#branches.set(branch, {
      head: id,
      sequence: stored.sequence,
      base: current.base,
    });
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
    const location = this.#commits.get(id);
    if (location === undefined) throw new HistoryUnavailableError(id);
    return location.value;
  }

  private retainedCommitIds(now: number): Set<CommitId> {
    if (this.#retention.mode === "forever") {
      return new Set(this.#commits.keys());
    }
    const retained = new Set<CommitId>();
    for (const branch of this.#branches.values()) {
      retained.add(branch.head);
      retained.add(branch.base);
    }
    for (const commit of this.#retains.values()) retained.add(commit);
    for (const commit of this.#snapshotPins.keys()) retained.add(commit);

    const cutoff =
      this.#retention.keepYoungerThanMs === undefined
        ? undefined
        : now - this.#retention.keepYoungerThanMs;
    for (const [id, location] of this.#commits) {
      if (
        cutoff !== undefined &&
        (location.value.committedAtMs ?? Number.NEGATIVE_INFINITY) >= cutoff
      ) {
        retained.add(id);
      }
    }

    for (const branch of this.#branches.keys()) {
      const commits = [...this.#commits.entries()]
        .filter(([, location]) => location.value.branch === branch)
        .sort(
          (left, right) => right[1].value.sequence - left[1].value.sequence,
        );
      for (const [id] of commits.slice(0, this.#retention.keepAtLeast)) {
        retained.add(id);
      }
    }

    for (const subscriber of this.#subscribers) {
      for (const [id, location] of this.#commits) {
        if (
          location.value.branch === subscriber.branch &&
          location.value.sequence > subscriber.retainAfter
        ) {
          retained.add(id);
        }
      }
    }
    return retained;
  }

  private historyFloorsFor(
    retained: ReadonlySet<CommitId>,
  ): Map<string, number> {
    const floors = new Map<string, number>();
    for (const [branch, state] of this.#branches) {
      const sequences = new Set(
        [...this.#commits.entries()]
          .filter(
            ([id, location]) =>
              retained.has(id) && location.value.branch === branch,
          )
          .map(([, location]) => location.value.sequence),
      );
      let floor = state.sequence;
      while (floor > 0 && sequences.has(floor)) floor -= 1;
      floors.set(branch, floor);
    }
    return floors;
  }

  private async collectGarbageNow(): Promise<GarbageCollectionReport> {
    this.assertOpen();
    const before = this.store.endOffset;
    const commitsBefore = this.#commits.size;
    const retained = this.retainedCommitIds(Date.now());
    const commits = [...this.#commits.entries()].filter(([id]) =>
      retained.has(id),
    );
    const floors = this.historyFloorsFor(retained);
    const temporaryPath = `${this.dataPath}.compact-${randomUUID()}`;
    const nextStore = await AppendOnlyPageStore.open(temporaryPath);
    const nextTree = new ImmutableBPlusTree(nextStore, this.treeOptions);
    let published = false;

    try {
      const manifests = commits.map(([, location]) =>
        cloneManifest(location.value.manifest),
      );
      const roots: TreeRoot[] = [];
      const setters: ((root: TreeRoot) => void)[] = [];
      for (const manifest of manifests) {
        for (const table of Object.values(manifest.tables)) {
          roots.push(table.primary);
          setters.push((root) => {
            table.primary = root;
          });
          for (const index of Object.keys(table.indexes)) {
            roots.push(table.indexes[index] ?? null);
            setters.push((root) => {
              table.indexes[index] = root;
            });
          }
        }
      }
      const copiedTrees = await this.tree.copyRootsTo(roots, nextTree);
      copiedTrees.roots.forEach((root, index) => setters[index]!(root));

      const nextCommits = new Map<CommitId, CommitLocation>();
      for (let index = 0; index < commits.length; index += 1) {
        const [id, location] = commits[index]!;
        const value: StoredCommit = {
          ...location.value,
          id,
          manifest: manifests[index]!,
        };
        const offset = await nextStore.append("commit", encodeValue(value));
        nextCommits.set(id, { offset, value });
      }

      let refCount = 0;
      for (const [branch, state] of this.#branches) {
        await nextStore.append(
          "ref",
          encodeValue({
            operation: "create",
            branch,
            head: state.base,
            sequence: 0,
          } satisfies StoredRef),
        );
        refCount += 1;
        const branchCommits = commits
          .filter(([, location]) => location.value.branch === branch)
          .sort(
            (left, right) => left[1].value.sequence - right[1].value.sequence,
          );
        for (const [id, location] of branchCommits) {
          if (location.value.sequence === 0) continue;
          await nextStore.append(
            "ref",
            encodeValue({
              operation: "commit",
              branch,
              head: id,
              sequence: location.value.sequence,
            } satisfies StoredRef),
          );
          refCount += 1;
        }
      }
      await nextStore.append(
        "meta",
        encodeValue({
          format: 2,
          retention: this.#retention,
          retains: Object.fromEntries(this.#retains),
          historyFloors: Object.fromEntries(floors),
        } satisfies StoredMetadata),
      );
      await nextStore.sync();
      const after = nextStore.endOffset;
      await rename(temporaryPath, this.dataPath);
      published = true;

      const previous = this.#generation;
      this.#generation = {
        store: nextStore,
        tree: nextTree,
        leases: 1,
        retired: false,
        closed: false,
      };
      this.#generations.add(this.#generation);
      this.#commits.clear();
      for (const [id, location] of nextCommits) {
        this.#commits.set(id, location);
      }
      this.#historyFloors.clear();
      for (const [branch, floor] of floors) {
        this.#historyFloors.set(branch, floor);
      }
      await syncParentDirectory(this.dataPath);
      previous.retired = true;
      await this.releaseGeneration(previous);

      return Object.freeze({
        commitsCollected: commitsBefore - commits.length,
        recordsCopied: copiedTrees.pagesCopied + commits.length + refCount + 1,
        bytesBefore: before,
        bytesAfter: after,
        bytesReclaimed: Math.max(0, before - after),
      });
    } catch (error) {
      if (!published) {
        nextTree.dispose();
        await nextStore.close();
        await rm(temporaryPath, { force: true });
      }
      throw error;
    }
  }

  private async releaseSnapshot(
    generation: StorageGeneration,
    commit: CommitId,
  ): Promise<void> {
    const pins = this.#snapshotPins.get(commit);
    if (pins === 1) this.#snapshotPins.delete(commit);
    else if (pins !== undefined) this.#snapshotPins.set(commit, pins - 1);
    await this.releaseGeneration(generation);
  }

  private async releaseGeneration(
    generation: StorageGeneration,
  ): Promise<void> {
    if (generation.closed) return;
    generation.leases -= 1;
    if (generation.leases === 0 && generation.retired) {
      await this.closeGeneration(generation);
    }
  }

  private async closeGeneration(generation: StorageGeneration): Promise<void> {
    if (generation.closed) return;
    generation.closed = true;
    generation.tree.dispose();
    await generation.store.close();
    this.#generations.delete(generation);
  }

  private async *readChanges(
    generation: StorageGeneration,
    branch: BranchName,
    after: BranchSequence,
    through: BranchSequence,
  ): AsyncIterable<CommitBatch> {
    for await (const record of generation.store.records(new Set(["ref"]))) {
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

export type NodeStorageOptions = Readonly<{
  directory: string;
  schema: AnySchema;
  cacheBytes?: number;
  maxEntries?: number;
  memory?: MemoryManager;
  /** Persisted on creation; an explicit mismatch on reopen is rejected. */
  retention?: RetentionPolicy;
}>;

export async function openNodeStorage(
  options: NodeStorageOptions,
): Promise<NodeStorageDatabase> {
  return NodeStorageDatabase.open(options);
}
