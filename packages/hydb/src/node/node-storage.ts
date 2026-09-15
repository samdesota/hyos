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
  type StorageMutation,
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
import {
  buildMigrationPlan,
  type Migration,
  type MigrationDatabase,
  type MigrationDataStep,
  type SchemaOp,
} from "./migration.js";
import { AppendOnlyPageStore } from "./page-store.js";
import { writeTrace, writeTraceNow } from "./write-trace.js";
import {
  readStartupCheckpoint,
  writeStartupCheckpoint,
  type StartupCheckpoint,
} from "./startup-checkpoint.js";

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
  /**
   * Progress marker written only by migration commits: the number of
   * migration steps already applied to the branch. cloneManifest drops it so
   * ordinary commits never inherit migration progress.
   */
  migration?: { step: number };
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

type CommitLocation = {
  offset: number;
  value?: StoredCommit;
};

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
  // The migration progress marker is intentionally dropped: only migration
  // commits themselves carry progress, so ordinary commits never inherit it.
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

function schemaMetadata(
  schema: AnySchema,
  addedNullableColumns: Readonly<Record<string, readonly string[]>> = {},
  omittedTables: readonly string[] = [],
): {
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
      const added = addedNullableColumns[definition.name] ?? [];
      for (const name of added) {
        const column = columns.find((column) => column.name === name);
        if (
          !column ||
          column.notNull ||
          column.primaryKey ||
          indexes.some((index) => index.columns.includes(name))
        ) {
          throw new TypeError(
            `Migration requires a nullable, non-indexed column: ${definition.name}.${name}`,
          );
        }
      }
      return {
        name: definition.name,
        columns: columns.filter((column) => !added.includes(column.name)),
        indexes,
      };
    })
    .filter((table) => !omittedTables.includes(table.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const name of Object.keys(addedNullableColumns)) {
    if (!tables.has(name))
      throw new TypeError(`Unknown migration table: ${name}`);
  }
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

/**
 * One executable migration step. `schema` steps come from the declarative
 * migration list (one commit per operation); `data` steps run a callback
 * against the storage and flush its writes as one commit; `legacy` steps are
 * the historical nullable-column/table-addition groups derived from the
 * deprecated inline options (one commit per group).
 */
type MigrationStepTask =
  | Readonly<{ kind: "schema"; op: SchemaOp; from: string; to: string }>
  | Readonly<{ kind: "data"; run: MigrationDataStep; fingerprint: string }>
  | Readonly<{
      kind: "legacy";
      from: string;
      to: string;
      columns: Readonly<Record<string, readonly string[]>>;
      tables?: readonly string[];
    }>;

/** A row write buffered by a data step, flushed as a single commit. */
type MigrationPendingRow = {
  table: string;
  key: StorageKey;
  encodedKey: Uint8Array;
  /** The row as it exists in committed storage, when it exists there. */
  before?: StoredRow;
  /** The row after the write; undefined means delete. */
  after?: StoredRow;
};

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
  readonly #schemaFingerprints: ReadonlySet<string>;
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
    private readonly migrationSteps: readonly MigrationStepTask[] = [],
    private readonly migrationBase: string = fingerprint,
    private readonly migrationFinal: string = fingerprint,
  ) {
    this.#generation = generation;
    this.#generations.add(generation);
    // Every schema fingerprint a branch head may legitimately carry: the
    // current schema, the migration base, and every step's target.
    const fingerprints = new Set<string>([
      fingerprint,
      migrationBase,
      migrationFinal,
    ]);
    for (const step of migrationSteps) {
      if (step.kind !== "data") fingerprints.add(step.from);
      fingerprints.add(step.kind === "data" ? step.fingerprint : step.to);
    }
    this.#schemaFingerprints = fingerprints;
  }

  private get store(): AppendOnlyPageStore {
    return this.#generation.store;
  }

  private get tree(): ImmutableBPlusTree {
    return this.#generation.tree;
  }

  static async open(options: NodeStorageOptions): Promise<NodeStorageDatabase> {
    const debugBoot = (event: string) => {
      if (process.env.HYOS_BOOT_TRACE === "1")
        console.log(`[DEBUG-boot-7f2c] storage ${event}`);
    };
    const requestedRetention =
      options.retention === undefined
        ? undefined
        : validateRetention(options.retention);
    await mkdir(options.directory, { recursive: true });
    const metadata = schemaMetadata(options.schema);
    let migrationSteps: MigrationStepTask[] = [];
    let migrationBase = metadata.fingerprint;
    let migrationFinal = metadata.fingerprint;
    if (options.migrations !== undefined) {
      if (
        options.addNullableColumns !== undefined ||
        options.nullableColumnMigrations !== undefined ||
        options.addedTables !== undefined ||
        options.addedTableMigrations !== undefined ||
        options.postAddedTableNullableColumnMigrations !== undefined
      ) {
        throw new TypeError(
          "Specify either migrations or the legacy migration options, not both",
        );
      }
      const plan = buildMigrationPlan(options.schema, options.migrations);
      migrationSteps = [...plan.steps];
      migrationBase = plan.base;
      migrationFinal = plan.final;
    }
    if (options.addNullableColumns && options.nullableColumnMigrations) {
      throw new TypeError("Specify only one nullable migration configuration");
    }
    if (options.addedTables && options.addedTableMigrations) {
      throw new TypeError(
        "Specify only one added-table migration configuration",
      );
    }
    // These nullable additions happened after the table additions. Remove
    // them when reconstructing every earlier schema fingerprint.
    const postTableSteps = options.postAddedTableNullableColumnMigrations ?? [];
    const postTableOmitted: Record<string, string[]> = {};
    let postTableTarget = metadata.fingerprint;
    const postTableMigrations = [...postTableSteps]
      .reverse()
      .map((columns) => {
        if (!Object.values(columns).some((names) => names.length))
          throw new TypeError("Empty nullable migration");
        for (const [table, names] of Object.entries(columns)) {
          const existing = (postTableOmitted[table] ??= []);
          for (const name of names) {
            if (existing.includes(name))
              throw new TypeError(
                `Duplicate migration column: ${table}.${name}`,
              );
            existing.push(name);
          }
        }
        const from = schemaMetadata(
          options.schema,
          postTableOmitted,
        ).fingerprint;
        const migration = { from, to: postTableTarget, columns };
        postTableTarget = from;
        return migration;
      })
      .reverse();
    // Table additions follow nullable-column migrations. Each group is one
    // historical schema step, allowing storage already upgraded through an
    // earlier group to resume at the next one.
    const addedTableSteps = (
      options.addedTableMigrations ??
      (options.addedTables ? [options.addedTables] : [])
    ).map((names) => [...names].sort());
    const addedTableNames = addedTableSteps.flat();
    if (new Set(addedTableNames).size !== addedTableNames.length) {
      throw new TypeError("Duplicate added-table migration");
    }
    const tablesAddedFingerprint = addedTableNames.length
      ? schemaMetadata(options.schema, postTableOmitted, addedTableNames)
          .fingerprint
      : postTableTarget;
    const steps =
      options.nullableColumnMigrations ??
      (options.addNullableColumns ? [options.addNullableColumns] : []);
    const omitted: Record<string, string[]> = Object.fromEntries(
      Object.entries(postTableOmitted).map(([table, names]) => [
        table,
        [...names],
      ]),
    );
    // The nullable-column chain composes on top of the table addition: its
    // oldest step must reach the pre-table-addition fingerprint.
    let target = tablesAddedFingerprint;
    const nullableMigrations: {
      from: string;
      to: string;
      columns: Readonly<Record<string, readonly string[]>>;
      tables?: readonly string[];
    }[] = [...steps]
      .reverse()
      .map((columns) => {
        if (!Object.values(columns).some((names) => names.length))
          throw new TypeError("Empty nullable migration");
        for (const [table, names] of Object.entries(columns)) {
          const existing = (omitted[table] ??= []);
          for (const name of names) {
            if (existing.includes(name))
              throw new TypeError(
                `Duplicate migration column: ${table}.${name}`,
              );
            existing.push(name);
          }
        }
        const from = schemaMetadata(
          options.schema,
          omitted,
          addedTableNames,
        ).fingerprint;
        const migration = { from, to: target, columns };
        target = from;
        return migration;
      })
      .reverse();
    // Add tables one historical group at a time. The target for each group
    // is the current schema with only its later groups omitted.
    let tableTarget = tablesAddedFingerprint;
    for (let index = 0; index < addedTableSteps.length; index += 1) {
      const tables = addedTableSteps[index]!;
      if (tables.length === 0)
        throw new TypeError("Empty added-table migration");
      const laterTables = addedTableSteps.slice(index + 1).flat();
      const nextTarget = schemaMetadata(
        options.schema,
        postTableOmitted,
        laterTables,
      ).fingerprint;
      nullableMigrations.push({
        from: tableTarget,
        to: nextTarget,
        columns: {},
        tables,
      });
      tableTarget = nextTarget;
    }
    nullableMigrations.push(...postTableMigrations);
    if (options.migrations === undefined) {
      // Legacy groups stay one commit per group, preserving the historical
      // behavior of the deprecated inline options.
      for (const migration of nullableMigrations) {
        if (!Object.keys(migration.columns).length && !migration.tables?.length)
          continue;
        migrationSteps.push({
          kind: "legacy",
          from: migration.from,
          to: migration.to,
          columns: migration.columns,
          ...(migration.tables ? { tables: migration.tables } : {}),
        });
      }
      migrationBase = nullableMigrations[0]?.from ?? metadata.fingerprint;
      migrationFinal = metadata.fingerprint;
    }
    const dataPath = join(options.directory, "hydb.data");
    debugBoot("checkpoint:read:start");
    const checkpoint = await readStartupCheckpoint(dataPath);
    debugBoot(
      `checkpoint:read:done valid=${Boolean(checkpoint)} offset=${checkpoint?.offset ?? 0}`,
    );
    debugBoot("page-store:open:start");
    const store = await AppendOnlyPageStore.open(dataPath, checkpoint?.offset);
    debugBoot(`page-store:open:done end=${store.endOffset}`);
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
      migrationSteps,
      migrationBase,
      migrationFinal,
    );
    try {
      debugBoot("log-load:start");
      await database.load(checkpoint);
      debugBoot("log-load:done");
      debugBoot("checkpoint:write:start");
      await database.checkpoint();
      debugBoot("checkpoint:write:done");
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
    if (!this.#schemaFingerprints.has(commit.manifest.schema)) {
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
    const wakeOnAbort = () => subscriber.wake?.();
    options.signal?.addEventListener("abort", wakeOnAbort, { once: true });
    this.#subscribers.add(subscriber);
    try {
      // Only replay when there is a range to replay. The replay scans every
      // ref record in the log; starting a stream at the current head (the
      // common case) must not read the whole log before live commits queued
      // by concurrent writers can be delivered.
      if (options.after < through) {
        const replayGeneration = this.#generation;
        replayGeneration.leases += 1;
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
    await this.checkpoint();
    await Promise.all(
      [...this.#generations].map((generation) =>
        this.closeGeneration(generation),
      ),
    );
  }

  private async checkpoint(): Promise<void> {
    // A checkpoint is a disposable accelerator; failure must not fail a commit or close.
    try {
      const trace = (event: string) => {
        if (process.env.HYOS_BOOT_TRACE === "1")
          console.log(`[DEBUG-boot-7f2c] checkpoint ${event}`);
      };
      trace("data-sync:start");
      await this.store.sync();
      trace("data-sync:done");
      trace(`sidecar-write:start commits=${this.#commits.size}`);
      await writeStartupCheckpoint(this.dataPath, {
        offset: this.store.endOffset,
        branches: [...this.#branches],
        commits: [...this.#commits].map(([id, location]) => [
          id,
          location.offset,
        ]),
        metadata: {
          format: 2,
          retention: this.#retention,
          retains: Object.fromEntries(this.#retains),
          historyFloors: Object.fromEntries(this.#historyFloors),
        },
      });
      trace("sidecar-write:done");
    } catch {
      /* Fall back to log recovery on the next open. */
    }
  }

  private async load(checkpoint?: StartupCheckpoint): Promise<void> {
    if (checkpoint) {
      for (const [id, offset] of checkpoint.commits)
        this.#commits.set(id, { offset });
      for (const [name, state] of checkpoint.branches)
        this.#branches.set(name, state);
      this.#retention = validateRetention(
        checkpoint.metadata.retention as RetentionPolicy,
      );
      for (const [name, id] of Object.entries(checkpoint.metadata.retains))
        this.#retains.set(name, id);
      for (const [name, floor] of Object.entries(
        checkpoint.metadata.historyFloors,
      ))
        this.#historyFloors.set(name, floor);
      this.#metadataFound = true;
    }
    const published = new Set<CommitId>(this.#commits.keys());
    for await (const record of this.store.records(
      new Set(["commit", "ref", "meta"]),
      checkpoint?.offset ?? 0,
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
      // Migrate an existing storage to the requested policy: append new
      // metadata so the change survives restarts. No data is rewritten —
      // reclamation happens on a later collection.
      this.#retention = this.requestedRetention;
      await this.writeMetadata();
      await this.store.sync();
    }
    // Validate every branch before writing anything. A crash can leave some branches
    // migrated; rerunning safely completes only the remaining old-schema heads.
    for (const state of this.#branches.values()) {
      const schema = (await this.readCommit(state.head)).manifest.schema;
      if (!this.#schemaFingerprints.has(schema)) {
        throw new TypeError(
          "Storage schema does not match the supplied schema",
        );
      }
    }
    await this.migrate();
    const main = this.#branches.get("main");
    if (main === undefined) throw new Error("Storage has no main branch");
    const head = await this.readCommit(main.head);
    if (head.manifest.schema !== this.fingerprint) {
      throw new TypeError("Storage schema does not match the supplied schema");
    }
  }

  /**
   * Applies every remaining migration step as its own commit per branch. The
   * resume index comes from the head commit's progress marker when present,
   * falling back to the schema fingerprint for storages last written by
   * versions without per-step markers. A crash between steps therefore
   * resumes exactly at the step that never committed.
   */
  private async migrate(): Promise<void> {
    for (const [branch, initial] of [...this.#branches]) {
      let state = initial;
      const head = await this.readCommit(state.head);
      for (
        let index = this.resumeStepIndex(head.manifest);
        index < this.migrationSteps.length;
        index += 1
      ) {
        const step = this.migrationSteps[index]!;
        state =
          step.kind === "data"
            ? await this.runDataStep(branch, state, step, index)
            : await this.runSchemaStep(branch, state, step, index);
      }
    }
  }

  /**
   * Determines which migration step a branch head must resume at. The
   * progress marker is only trusted when it agrees with the head schema
   * fingerprint: markers written by an earlier migration step list (for
   * example the deprecated inline group options) do not index the supplied
   * steps, so a stale index must never skip or repeat work.
   */
  private resumeStepIndex(manifest: DatabaseManifest): number {
    const steps = this.migrationSteps;
    const schema = manifest.schema;
    const marker = manifest.migration;
    if (marker !== undefined) {
      if (
        typeof marker.step !== "number" ||
        !Number.isSafeInteger(marker.step) ||
        marker.step < 0 ||
        marker.step > steps.length
      ) {
        throw new TypeError(
          "Storage migration progress marker does not match the supplied migrations",
        );
      }
      const next = steps[marker.step];
      const nextFrom =
        next === undefined
          ? this.migrationFinal
          : next.kind === "data"
            ? next.fingerprint
            : next.from;
      if (schema === nextFrom) return marker.step;
    }
    if (schema === this.migrationFinal) return steps.length;
    if (schema === this.migrationBase) return 0;
    // Commits written before per-step markers existed sit at an intermediate
    // chain fingerprint; resume after the step that produced it.
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]!;
      const target = step.kind === "data" ? step.fingerprint : step.to;
      if (target === schema) return index + 1;
    }
    throw new TypeError("Storage schema does not match the supplied schema");
  }

  private assertIndexFree(
    metadata: TableMetadata,
    column: string,
    action: string,
  ): void {
    for (const index of metadata.indexes) {
      if (index.columns.includes(column)) {
        throw new TypeError(
          `Cannot ${action} indexed column: ${metadata.name}.${column}`,
        );
      }
    }
  }

  private async runSchemaStep(
    branch: BranchName,
    state: BranchState,
    step: Extract<MigrationStepTask, { kind: "schema" | "legacy" }>,
    index: number,
  ): Promise<BranchState> {
    const parent = await this.readCommit(state.head);
    if (parent.manifest.schema !== step.from) {
      throw new TypeError(
        `Migration step ${index + 1} expects schema ${step.from}; storage is at ${parent.manifest.schema}`,
      );
    }
    const manifest = cloneManifest(parent.manifest);
    const changes: StoredChange[] = [];
    if (step.kind === "legacy") {
      await this.applyLegacyGroup(manifest, changes, step);
    } else {
      await this.applySchemaOp(manifest, changes, step.op);
    }
    manifest.schema = step.to;
    manifest.migration = { step: index + 1 };
    return await this.publishMigrationCommit(branch, state, manifest, changes);
  }

  /** Historical nullable-column/table-addition group from the legacy options. */
  private async applyLegacyGroup(
    manifest: DatabaseManifest,
    changes: StoredChange[],
    step: Extract<MigrationStepTask, { kind: "legacy" }>,
  ): Promise<void> {
    // Added tables carry no existing rows; they only need manifest entries so
    // later writes against them resolve.
    for (const name of step.tables ?? []) {
      const metadata = this.tables.get(name);
      if (metadata === undefined)
        throw new TypeError(`Unknown migration table: ${name}`);
      manifest.tables[name] = {
        primary: null,
        indexes: Object.fromEntries(
          metadata.indexes.map((index) => [index.name, null]),
        ),
      };
    }
    for (const [name, columns] of Object.entries(step.columns)) {
      const table = manifest.tables[name]!;
      const metadata = this.tables.get(name)!;
      const original = table.primary;
      for await (const entry of this.tree.scan(original)) {
        const before = decodeRow(entry.value);
        const after = {
          ...before,
          ...Object.fromEntries(columns.map((column) => [column, null])),
        };
        table.primary = await this.tree.mutate(table.primary, [
          { type: "put", key: entry.key, value: encodeValue(after) },
        ]);
        changes.push({
          table: name,
          key: primaryKey(metadata, before),
          before,
          after,
        });
      }
    }
  }

  /**
   * Applies one declarative schema operation. The default row rewrite adds
   * new columns as null and strips dropped ones; changeColumn keeps row
   * values (conversions belong in interleaved data steps), and added tables
   * only seed their manifest entry.
   */
  private async applySchemaOp(
    manifest: DatabaseManifest,
    changes: StoredChange[],
    op: SchemaOp,
  ): Promise<void> {
    if (op.type === "addTable") {
      const metadata = this.tables.get(op.description.name);
      if (metadata === undefined) {
        throw new TypeError(`Unknown migration table: ${op.description.name}`);
      }
      manifest.tables[op.description.name] = {
        primary: null,
        indexes: Object.fromEntries(
          metadata.indexes.map((index) => [index.name, null]),
        ),
      };
      return;
    }
    if (op.type === "dropTable") {
      if (manifest.tables[op.description.name] === undefined) {
        throw new TypeError(`Unknown migration table: ${op.description.name}`);
      }
      delete manifest.tables[op.description.name];
      return;
    }
    const table = manifest.tables[op.table];
    const metadata = this.tables.get(op.table);
    if (table === undefined || metadata === undefined) {
      throw new TypeError(`Unknown migration table: ${op.table}`);
    }
    if (op.type === "changeColumn") {
      this.assertIndexFree(metadata, op.column.name, "change");
      return;
    }
    this.assertIndexFree(
      metadata,
      op.column.name,
      op.type === "addColumn" ? "add" : "drop",
    );
    const original = table.primary;
    for await (const entry of this.tree.scan(original)) {
      const before = decodeRow(entry.value);
      let after: StoredRow;
      if (op.type === "addColumn") {
        after = { ...before, [op.column.name]: null };
      } else {
        const { [op.column.name]: _removed, ...rest } = before;
        if (Object.keys(rest).length === Object.keys(before).length) continue;
        after = rest;
      }
      table.primary = await this.tree.mutate(table.primary, [
        { type: "put", key: entry.key, value: encodeValue(after) },
      ]);
      changes.push({
        table: op.table,
        key: primaryKey(metadata, before),
        before,
        after,
      });
    }
  }

  private async runDataStep(
    branch: BranchName,
    state: BranchState,
    step: Extract<MigrationStepTask, { kind: "data" }>,
    index: number,
  ): Promise<BranchState> {
    const parent = await this.readCommit(state.head);
    if (parent.manifest.schema !== step.fingerprint) {
      throw new TypeError(
        `Migration data step ${index + 1} expects schema ${step.fingerprint}; storage is at ${parent.manifest.schema}`,
      );
    }
    const pending = new Map<string, MigrationPendingRow>();
    await step.run(this.migrationDatabase(parent.manifest, pending));
    // An empty data step still commits so the progress marker advances.
    const mutations: StorageMutation[] = [];
    for (const op of pending.values()) {
      const table = this.tables.get(op.table)?.table;
      if (table === undefined) {
        throw new TypeError(`Unknown migration table: ${op.table}`);
      }
      if (op.after === undefined) {
        mutations.push({ type: "delete", table, key: op.key });
      } else if (op.before === undefined) {
        mutations.push({ type: "insert", table, row: op.after });
      } else {
        mutations.push({ type: "update", table, key: op.key, row: op.after });
      }
    }
    await this.commitNow(
      { branch, expectedHead: state.head, mutations },
      index + 1,
    );
    return this.#branches.get(branch)!;
  }

  /**
   * The database surface handed to a data step. Reads see committed rows with
   * the step's buffered writes overlaid; writes are buffered and flushed as
   * one commit when the step finishes.
   */
  private migrationDatabase(
    manifest: DatabaseManifest,
    pending: Map<string, MigrationPendingRow>,
  ): MigrationDatabase {
    const database = this;
    const resolve = (table: string) => {
      const entry = manifest.tables[table];
      const metadata = database.tables.get(table);
      if (entry === undefined || metadata === undefined) {
        throw new TypeError(`Unknown table: ${table}`);
      }
      return entry;
    };
    const pendingKey = (table: string, encoded: Uint8Array): string =>
      `${table}:${Buffer.from(encoded).toString("hex")}`;
    const treeRow = async (
      table: string,
      encoded: Uint8Array,
    ): Promise<StoredRow | undefined> => {
      const bytes = await database.tree.get(resolve(table).primary, encoded);
      return bytes === undefined ? undefined : decodeRow(bytes);
    };
    const currentRow = async (
      table: string,
      encoded: Uint8Array,
    ): Promise<StoredRow | undefined> => {
      const op = pending.get(pendingKey(table, encoded));
      if (op !== undefined) return op.after ?? undefined;
      return await treeRow(table, encoded);
    };
    const buffer = (
      table: string,
      key: StorageKey,
      encoded: Uint8Array,
      after: StoredRow | undefined,
      before: StoredRow | undefined,
    ): void => {
      const previous = pending.get(pendingKey(table, encoded));
      pending.set(pendingKey(table, encoded), {
        table,
        key: [...key],
        encodedKey: encoded,
        after,
        ...(previous?.before !== undefined
          ? { before: previous.before }
          : before !== undefined
            ? { before }
            : {}),
      });
    };
    const scanRows = async function* (
      table: string,
    ): AsyncGenerator<StoredRow> {
      const root = resolve(table).primary;
      const ops = [...pending.values()]
        .filter((op) => op.table === table)
        .sort((left, right) =>
          Buffer.compare(left.encodedKey, right.encodedKey),
        );
      let opIndex = 0;
      for await (const entry of database.tree.scan(root)) {
        const encoded = entry.key;
        while (
          opIndex < ops.length &&
          Buffer.compare(ops[opIndex]!.encodedKey, encoded) < 0
        ) {
          const op = ops[opIndex++]!;
          if (op.after !== undefined) yield op.after;
        }
        if (
          opIndex < ops.length &&
          Buffer.compare(ops[opIndex]!.encodedKey, encoded) === 0
        ) {
          const op = ops[opIndex++]!;
          if (op.after !== undefined) yield op.after;
          continue;
        }
        yield decodeRow(entry.value);
      }
      while (opIndex < ops.length) {
        const op = ops[opIndex++]!;
        if (op.after !== undefined) yield op.after;
      }
    };
    return {
      scan: (table) => scanRows(table),
      insert: async (table, row) => {
        resolve(table);
        const metadata = database.tables.get(table)!;
        const key = primaryKey(metadata, row as StoredRow);
        const encoded = encodeOrderedKey(key);
        if ((await currentRow(table, encoded)) !== undefined) {
          throw new TypeError(`Duplicate primary key for table ${table}`);
        }
        buffer(table, key, encoded, cloneRow(row), undefined);
      },
      update: async (table, key, patch) => {
        resolve(table);
        const metadata = database.tables.get(table)!;
        const encoded = encodeOrderedKey(key);
        const current = await currentRow(table, encoded);
        if (current === undefined) {
          throw new TypeError(`Missing row for table ${table}`);
        }
        const after = { ...current, ...patch };
        if (
          Buffer.compare(
            encodeOrderedKey(primaryKey(metadata, after)),
            encoded,
          ) !== 0
        ) {
          throw new TypeError(
            `Primary keys cannot be updated for table ${table}`,
          );
        }
        const previous = pending.get(pendingKey(table, encoded));
        buffer(
          table,
          key,
          encoded,
          after,
          previous?.before ??
            (previous === undefined
              ? await treeRow(table, encoded)
              : undefined),
        );
      },
      delete: async (table, key) => {
        resolve(table);
        const encoded = encodeOrderedKey(key);
        const current = await currentRow(table, encoded);
        if (current === undefined) {
          throw new TypeError(`Missing row for table ${table}`);
        }
        const previous = pending.get(pendingKey(table, encoded));
        buffer(
          table,
          key,
          encoded,
          undefined,
          previous?.before ??
            (previous === undefined
              ? await treeRow(table, encoded)
              : undefined),
        );
      },
    };
  }

  private async publishMigrationCommit(
    branch: BranchName,
    state: BranchState,
    manifest: DatabaseManifest,
    changes: StoredChange[],
  ): Promise<BranchState> {
    const stored: StoredCommit = {
      id: newCommitId(),
      committedAtMs: Date.now(),
      parent: state.head,
      branch,
      sequence: state.sequence + 1,
      manifest,
      changes,
    };
    const offset = await this.store.append("commit", encodeValue(stored));
    await this.store.append(
      "ref",
      encodeValue({
        operation: "commit",
        branch,
        head: stored.id!,
        sequence: stored.sequence,
      } satisfies StoredRef),
    );
    await this.store.sync();
    this.#commits.set(stored.id!, { offset, value: stored });
    const next: BranchState = {
      ...state,
      head: stored.id!,
      sequence: stored.sequence,
    };
    this.#branches.set(branch, next);
    return next;
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

  private async commitNow(
    request: CommitRequest,
    migrationStep?: number,
  ): Promise<CommitBatch> {
    const traceStartedAt = writeTraceNow();
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
    if (migrationStep !== undefined) {
      manifest.migration = { step: migrationStep };
    }
    const changes: StoredChange[] = [];
    const mutationsStartedAt = writeTraceNow();

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
    const appendStartedAt = writeTraceNow();
    writeTrace(
      `commit-apply(${branch}, ${changes.length} changes)`,
      appendStartedAt - mutationsStartedAt,
    );
    const offset = await this.store.append("commit", encodeValue(stored));
    const id = stored.id!;
    const ref: StoredRef = {
      operation: "commit",
      branch,
      head: id,
      sequence: stored.sequence,
    };
    await this.store.append("ref", encodeValue(ref));
    const syncStartedAt = writeTraceNow();
    writeTrace("commit-append(2 records)", syncStartedAt - appendStartedAt);
    await this.store.sync();
    writeTrace("commit-fsync", writeTraceNow() - syncStartedAt);
    writeTrace(`commit-total(${branch})`, writeTraceNow() - traceStartedAt);
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
    if (!location.value!)
      location.value! = decodeValue(
        (await this.store.read(location.offset, "commit")).payload,
      ) as StoredCommit;
    return location.value!;
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
        (location.value!.committedAtMs ?? Number.NEGATIVE_INFINITY) >= cutoff
      ) {
        retained.add(id);
      }
    }

    for (const branch of this.#branches.keys()) {
      const commits = [...this.#commits.entries()]
        .filter(([, location]) => location.value!.branch === branch)
        .sort(
          (left, right) => right[1].value!.sequence - left[1].value!.sequence,
        );
      for (const [id] of commits.slice(0, this.#retention.keepAtLeast)) {
        retained.add(id);
      }
    }

    for (const subscriber of this.#subscribers) {
      for (const [id, location] of this.#commits) {
        if (
          location.value!.branch === subscriber.branch &&
          location.value!.sequence > subscriber.retainAfter
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
              retained.has(id) && location.value!.branch === branch,
          )
          .map(([, location]) => location.value!.sequence),
      );
      let floor = state.sequence;
      while (floor > 0 && sequences.has(floor)) floor -= 1;
      floors.set(branch, floor);
    }
    return floors;
  }

  private async collectGarbageNow(): Promise<GarbageCollectionReport> {
    this.assertOpen();
    // Collection needs every manifest; normal startup only loads the current head.
    for (const id of this.#commits.keys()) await this.readCommit(id);
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
        cloneManifest(location.value!.manifest),
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
          ...location.value!,
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
          .filter(([, location]) => location.value!.branch === branch)
          .sort(
            (left, right) => left[1].value!.sequence - right[1].value!.sequence,
          );
        for (const [id, location] of branchCommits) {
          if (location.value!.sequence === 0) continue;
          await nextStore.append(
            "ref",
            encodeValue({
              operation: "commit",
              branch,
              head: id,
              sequence: location.value!.sequence,
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
    const enqueuedAt = writeTraceNow();
    const result = this.#writeQueue.then(() => {
      writeTrace("queue-wait", writeTraceNow() - enqueuedAt);
      return operation();
    });
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
  /** Ordered migration list, oldest first, declared with defineMigration.
   * Opens any intermediate schema covered by the list and applies only the
   * remaining steps. Do not combine with the legacy migration options. */
  migrations?: readonly Migration[];
  /** Legacy: explicitly upgrade the exact schema obtained by removing these nullable,
   * non-indexed columns. Existing rows receive null; historical commits are unchanged. */
  addNullableColumns?: Readonly<Record<string, readonly string[]>>;
  /** Ordered additions, oldest first. Opens any declared intermediate schema and
   * applies only the remaining steps. Do not combine with addNullableColumns. */
  nullableColumnMigrations?: readonly Readonly<
    Record<string, readonly string[]>
  >[];
  /** Tables newly added to the schema since the storage was created. Opening
   * an existing storage seeds them into the manifest; no rows are rewritten. */
  addedTables?: readonly string[];
  /** Ordered table-addition groups, oldest first. Opens any declared
   * intermediate schema and applies only the remaining groups. */
  addedTableMigrations?: readonly (readonly string[])[];
  /** Nullable-column additions after all added-table groups, oldest first. */
  postAddedTableNullableColumnMigrations?: readonly Readonly<
    Record<string, readonly string[]>
  >[];
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
