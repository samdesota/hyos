import {
  DifferentialQuery,
  type DataflowSpillOptions,
  type QueryDemand,
} from "./dataflow.js";
import {
  planQuery,
  type PhysicalAccess,
  type PhysicalQueryPlan,
  type PlannedValue,
} from "./planner.js";
import type { InferQueryResult, Query, QuerySource } from "./query.js";
import {
  getColumnDefinition,
  getIndexDefinition,
  getTableDefinition,
  type AnySchema,
  type AnyTable,
} from "./schema.js";
import {
  encodeStorageKey,
  type CommitBatch,
  type CommittedChange,
  type StorageDatabase,
  type StorageKey,
  type StorageRange,
  type StorageSnapshot,
} from "./storage.js";
import {
  estimateMemoryBytes,
  type MemoryHandle,
  type MemoryManager,
} from "./memory.js";
import type { SpillOptions, SpillSession } from "./spill.js";

type StoredRow = Readonly<Record<string, unknown>>;
type QueryContext = ReadonlyMap<QuerySource, StoredRow>;
type DemandEntry = { key: StorageKey; references: number };
type SourceScope = Readonly<{
  plan: PhysicalQueryPlan;
  mode: "static" | "demand" | "fallback";
  demands: Map<string, DemandEntry>;
}>;
type BufferedCommit = Readonly<{
  commit: CommitBatch;
  resolve: () => void;
  reject: (error: unknown) => void;
}>;

function keyForRow(table: AnyTable, row: StoredRow): StorageKey {
  return Object.entries(getTableDefinition(table).columns)
    .filter(([, column]) => getColumnDefinition(column).primaryKey)
    .map(([name]) => row[name]);
}

function resolveKey(
  values: readonly PlannedValue[],
  context?: QueryContext,
): StorageKey | undefined {
  const key: unknown[] = [];
  for (const value of values) {
    if (value.kind === "literal") key.push(value.value);
    else {
      const resolved = context?.get(value.source)?.[value.column];
      if (resolved === undefined) return undefined;
      key.push(resolved);
    }
  }
  return key;
}

function collectPlans(
  plan: PhysicalQueryPlan,
  plans: PhysicalQueryPlan[] = [],
): readonly PhysicalQueryPlan[] {
  plans.push(plan);
  if (plan.authorization !== undefined) {
    collectPlans(plan.authorization.parent, plans);
  }
  if (plan.selection !== undefined) {
    for (const value of Object.values(plan.selection)) {
      if (value.kind === "query") collectPlans(value.plan, plans);
    }
  }
  return plans;
}

function scopeMode(plan: PhysicalQueryPlan): SourceScope["mode"] {
  if (plan.access.kind === "table-scan") return "fallback";
  return plan.access.key.some((value) => value.kind === "outer-field")
    ? "demand"
    : "static";
}

function accessKeyForRow(access: PhysicalAccess, row: StoredRow): StorageKey {
  if (access.kind === "primary-key") return keyForRow(access.table, row);
  if (access.kind === "table-scan") return [];
  const definition = getTableDefinition(access.table).indexes.find(
    (candidate) => getIndexDefinition(candidate).name === access.index,
  );
  if (definition === undefined) {
    throw new TypeError(`Unknown index: ${access.index}`);
  }
  return getIndexDefinition(definition).columns.map(
    (column) => row[getColumnDefinition(column).name],
  );
}

function rowMatchesKey(
  access: PhysicalAccess,
  row: StoredRow,
  key: StorageKey,
): boolean {
  if (access.kind === "table-scan") return true;
  const rowKey = accessKeyForRow(access, row).slice(0, key.length);
  return encodeStorageKey(rowKey) === encodeStorageKey(key);
}

async function loadRows(
  snapshot: StorageSnapshot,
  access: PhysicalAccess,
  key = access.kind === "primary-key" || access.kind === "index-scan"
    ? resolveKey(access.key)
    : undefined,
): Promise<Map<string, StoredRow>> {
  const table = access.table;
  const rows = new Map<string, StoredRow>();
  if (access.kind === "primary-key" && key !== undefined) {
    const row = await snapshot.get(table, key);
    if (row !== undefined) {
      rows.set(encodeStorageKey(keyForRow(table, row)), row);
    }
    return rows;
  }

  const range: StorageRange | undefined =
    access.kind === "table-scan" || access.kind === "index-scan"
      ? { reverse: access.reverse }
      : undefined;
  const request =
    access.kind === "index-scan" && key !== undefined
      ? {
          type: "index" as const,
          table,
          index: access.index,
          ...(key.length === 0 ? {} : { key }),
          range,
        }
      : { type: "table" as const, table };
  for await (const batch of snapshot.scan(request)) {
    for (const row of batch) {
      rows.set(encodeStorageKey(keyForRow(table, row)), row);
    }
  }
  return rows;
}

export class SubscriptionRuntime<QueryValue extends Query<any>> {
  readonly ready: Promise<void>;
  readonly #scopes: readonly SourceScope[];
  readonly #scopeBySource: ReadonlyMap<QuerySource, SourceScope>;
  readonly #rowsBySource = new Map<QuerySource, Map<string, StoredRow>>();
  readonly #rowBytesBySource = new Map<QuerySource, Map<string, number>>();
  readonly #memory: MemoryHandle;
  #rowBytes = 0;
  #query?: DifferentialQuery<QueryValue>;
  #snapshot?: StorageSnapshot;
  #buffer: BufferedCommit[] = [];
  #pendingDemands: QueryDemand[] = [];
  #lastSequence = -1;
  #live = false;
  #disposed = false;
  #applyQueue: Promise<void> = Promise.resolve();
  #spillSession?: Promise<SpillSession>;
  #disposePromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly schema: AnySchema,
    private readonly storage: StorageDatabase,
    private readonly queryValue: QueryValue,
    private readonly listener: (result: InferQueryResult<QueryValue>) => void,
    private readonly memoryManager: MemoryManager,
    private readonly spillOptions?: SpillOptions,
  ) {
    this.#memory = memoryManager.track({
      owner: "subscriptions",
      priority: 30,
    });
    this.#scopes = collectPlans(planQuery(schema, queryValue)).map((plan) => ({
      plan,
      mode: scopeMode(plan),
      demands: new Map(),
    }));
    this.#scopeBySource = new Map(
      this.#scopes.map((scope) => [scope.plan.source, scope]),
    );
    for (const scope of this.#scopes) {
      this.#rowsBySource.set(scope.plan.source, new Map());
      this.#rowBytesBySource.set(scope.plan.source, new Map());
    }
    this.ready = this.bootstrap();
  }

  accept(commit: CommitBatch): Promise<void> {
    if (this.#disposed || commit.sequence <= this.#lastSequence) {
      return Promise.resolve();
    }
    if (!this.#live) {
      return new Promise<void>((resolve, reject) => {
        this.#buffer.push({ commit, resolve, reject });
      });
    }
    return this.enqueue(commit);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const buffered of this.#buffer) buffered.resolve();
    this.#buffer = [];
    this.#pendingDemands = [];
    this.#query?.dispose();
    this.#memory.release();
    this.#disposePromise = this.releaseResources();
  }

  whenDisposed(): Promise<void> {
    return this.#disposePromise;
  }

  private async bootstrap(): Promise<void> {
    const snapshot = await this.storage.snapshot();
    this.#snapshot = snapshot;
    try {
      const fallbackRows = new Map<string, Map<string, StoredRow>>();
      for (const scope of this.#scopes) {
        if (this.#disposed) return;
        if (scope.mode === "demand") continue;
        const table = scope.plan.source.table;
        let rows =
          scope.mode === "fallback" ? fallbackRows.get(table) : undefined;
        if (rows === undefined) {
          rows = await loadRows(snapshot, scope.plan.access);
          if (scope.mode === "fallback") fallbackRows.set(table, rows);
        }
        this.mergeRows(scope, rows);
      }

      if (this.#disposed) return;
      const query = new DifferentialQuery(
        this.queryValue,
        this.#rowsBySource,
        this.listener,
        (demands) => this.#pendingDemands.push(...demands),
        this.memoryManager,
        this.dataflowSpill(),
      );
      this.#query = query;
      this.#lastSequence = snapshot.sequence;
      await query.bootstrap();
      await this.settleDemands(snapshot);
      query.publishInitial();

      while (this.#buffer.length > 0 && !this.#disposed) {
        const buffered = this.#buffer.shift()!;
        try {
          await this.apply(buffered.commit);
          buffered.resolve();
        } catch (error) {
          buffered.reject(error);
          throw error;
        }
      }
      this.#live = !this.#disposed;
    } finally {
      await this.releaseSnapshot();
    }
  }

  private enqueue(commit: CommitBatch): Promise<void> {
    const operation = this.#applyQueue.then(() => this.apply(commit));
    this.#applyQueue = operation.catch(() => undefined);
    return operation;
  }

  private async apply(commit: CommitBatch): Promise<void> {
    if (this.#disposed || commit.sequence <= this.#lastSequence) return;
    const relevant = commit.changes.some((change) => {
      const table = getTableDefinition(change.table).name;
      return this.#scopes.some((scope) => scope.plan.source.table === table);
    });
    if (relevant) {
      const query = this.#query!;
      query.begin();
      for (const scope of this.#scopes) {
        const changes = this.filterChanges(scope, commit);
        await query.apply(scope.plan.source, changes);
      }
      if (this.#pendingDemands.length > 0) {
        const snapshot = await this.storage.snapshot({ commit: commit.commit });
        this.#snapshot = snapshot;
        try {
          await this.settleDemands(snapshot);
        } catch (error) {
          if (!this.#disposed) throw error;
          return;
        } finally {
          await this.releaseSnapshot();
        }
      }
      query.flush();
    }
    this.#lastSequence = commit.sequence;
  }

  private async settleDemands(snapshot: StorageSnapshot): Promise<void> {
    while (this.#pendingDemands.length > 0 && !this.#disposed) {
      const pending = this.#pendingDemands;
      this.#pendingDemands = [];
      const before = new Map<SourceScope, Map<string, number>>();
      for (const demand of pending) {
        const scope = this.#scopeBySource.get(demand.source);
        if (scope?.mode !== "demand") continue;
        const access = scope.plan.access;
        if (access.kind === "table-scan") continue;
        const key = resolveKey(access.key, demand.context);
        if (key === undefined) continue;
        const encoded = encodeStorageKey(key);
        let counts = before.get(scope);
        if (counts === undefined) {
          counts = new Map();
          before.set(scope, counts);
        }
        const entry = scope.demands.get(encoded) ?? { key, references: 0 };
        if (!counts.has(encoded)) counts.set(encoded, entry.references);
        entry.references += demand.diff;
        if (entry.references < 0) {
          throw new Error(
            "Subscription demand reference count became negative",
          );
        }
        if (entry.references === 0) scope.demands.delete(encoded);
        else scope.demands.set(encoded, entry);
      }

      for (const [scope, counts] of before) {
        for (const [encoded, previous] of counts) {
          const entry = scope.demands.get(encoded);
          if (previous !== 0 || entry === undefined) continue;
          const rows = await loadRows(snapshot, scope.plan.access, entry.key);
          const added = this.mergeRows(scope, rows);
          await this.#query!.seed(scope.plan.source, added);
        }
      }

      const scopesToEvict = new Set<SourceScope>();
      for (const [scope, counts] of before) {
        for (const [encoded, previous] of counts) {
          if (previous > 0 && !scope.demands.has(encoded)) {
            scopesToEvict.add(scope);
          }
        }
      }
      for (const scope of scopesToEvict) await this.evictIrrelevantRows(scope);
    }
  }

  private mergeRows(
    scope: SourceScope,
    rows: ReadonlyMap<string, StoredRow>,
  ): Map<string, StoredRow> {
    const stored = this.#rowsBySource.get(scope.plan.source);
    if (stored === undefined) {
      throw new TypeError(`Unknown query source: ${scope.plan.source.table}`);
    }
    const changed = new Map<string, StoredRow>();
    for (const [id, row] of rows) {
      this.accountRow(scope.plan.source, id, row);
      stored.set(id, row);
      changed.set(id, row);
    }
    return changed;
  }

  private filterChanges(
    scope: SourceScope,
    commit: CommitBatch,
  ): readonly CommittedChange[] {
    const changes: CommittedChange[] = [];
    const table = scope.plan.source.table;
    const rows = this.#rowsBySource.get(scope.plan.source)!;
    for (const change of commit.changes) {
      if (getTableDefinition(change.table).name !== table) continue;
      const id = encodeStorageKey(change.key);
      const before = rows.get(id);
      const after =
        change.after !== undefined && this.isRelevant(scope, change.after)
          ? change.after
          : undefined;
      if (before === undefined && after === undefined) continue;
      if (after === undefined) {
        rows.delete(id);
        this.forgetRow(scope.plan.source, id);
      } else {
        rows.set(id, after);
        this.accountRow(scope.plan.source, id, after);
      }
      changes.push({
        table: change.table,
        key: change.key,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      });
    }
    return changes;
  }

  private isRelevant(scope: SourceScope, row: StoredRow): boolean {
    if (scope.mode === "fallback") return true;
    const access = scope.plan.access;
    if (access.kind === "table-scan") return true;
    if (scope.mode === "static") {
      const key = resolveKey(access.key);
      return key !== undefined && rowMatchesKey(access, row, key);
    }
    for (const demand of scope.demands.values()) {
      if (rowMatchesKey(access, row, demand.key)) return true;
    }
    return false;
  }

  private async evictIrrelevantRows(scope: SourceScope): Promise<void> {
    const rows = this.#rowsBySource.get(scope.plan.source);
    if (rows === undefined) return;
    const removed: string[] = [];
    for (const [id, row] of rows) {
      if (this.isRelevant(scope, row)) continue;
      rows.delete(id);
      this.forgetRow(scope.plan.source, id);
      removed.push(id);
    }
    await this.#query!.remove(scope.plan.source, removed);
  }

  private async releaseSnapshot(): Promise<void> {
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return;
    this.#snapshot = undefined;
    await snapshot.close();
  }

  private dataflowSpill(): DataflowSpillOptions | undefined {
    if (this.spillOptions === undefined) return undefined;
    return {
      memoryBytes: this.spillOptions.memoryBytes ?? 8 * 1024 * 1024,
      session: () => {
        this.#spillSession ??= this.spillOptions!.store.createSession({
          owner: "subscription",
        });
        return this.#spillSession;
      },
    };
  }

  private async releaseResources(): Promise<void> {
    await Promise.allSettled([this.ready, this.#applyQueue]);
    await this.releaseSnapshot();
    if (this.#spillSession !== undefined) {
      await (await this.#spillSession).close();
    }
  }

  private accountRow(source: QuerySource, id: string, row: StoredRow): void {
    const sizes = this.#rowBytesBySource.get(source)!;
    this.#rowBytes -= sizes.get(id) ?? 0;
    const bytes = 96 + estimateMemoryBytes(id) + estimateMemoryBytes(row);
    sizes.set(id, bytes);
    this.#rowBytes += bytes;
    this.#memory.resize(this.#rowBytes);
  }

  private forgetRow(source: QuerySource, id: string): void {
    const sizes = this.#rowBytesBySource.get(source)!;
    const bytes = sizes.get(id);
    if (bytes === undefined) return;
    sizes.delete(id);
    this.#rowBytes -= bytes;
    this.#memory.resize(this.#rowBytes);
  }
}
