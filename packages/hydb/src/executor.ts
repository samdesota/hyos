import {
  estimateMemoryBytes,
  type MemoryHandle,
  type MemoryManager,
} from "./memory.js";
import type { PhysicalQueryPlan, PlannedValue } from "./planner.js";
import {
  compareQueryValues,
  evaluateExpressionNode,
  type QuerySource,
} from "./query.js";
import {
  getColumnDefinition,
  getTableDefinition,
  type AnyTable,
} from "./schema.js";
import { decodeSpillValue, encodeSpillValue } from "./spill-codec.js";
import { SpillableHashIndex } from "./spill-join.js";
import { SpillableSorter } from "./spill-sort.js";
import type { SpillOptions, SpillSession } from "./spill.js";
import {
  encodeStorageKey,
  type StorageKey,
  type StorageRange,
  type StorageSnapshot,
} from "./storage.js";

type StoredRow = Readonly<Record<string, unknown>>;
type ExecutionContext = ReadonlyMap<QuerySource, StoredRow>;
type Match = Readonly<{
  context: ExecutionContext;
  row: StoredRow;
  stableId: string;
}>;

class ExecutionMemory {
  readonly #handle?: MemoryHandle;
  #bytes = 0;

  constructor(memory?: MemoryManager) {
    this.#handle = memory?.track({ owner: "executor", priority: 20 });
  }

  add(value: unknown, overhead = 0): void {
    this.#bytes += estimateMemoryBytes(value) + overhead;
    this.#handle?.resize(this.#bytes);
  }

  addBytes(bytes: number): void {
    this.#bytes += bytes;
    this.#handle?.resize(this.#bytes);
  }

  release(): void {
    this.#handle?.release();
  }
}

class QuerySpill {
  #session?: Promise<SpillSession>;
  readonly #hashIndexes = new Map<
    PhysicalQueryPlan,
    Promise<SpillableHashIndex<StoredRow>>
  >();
  readonly #authorizationKeys = new Map<
    PhysicalQueryPlan,
    Promise<ReadonlySet<string>>
  >();

  constructor(readonly options?: SpillOptions) {}

  get memoryBytes(): number {
    return this.options === undefined
      ? Number.MAX_SAFE_INTEGER
      : (this.options.memoryBytes ?? 8 * 1024 * 1024);
  }

  session(): Promise<SpillSession> {
    if (this.options === undefined)
      throw new Error("Spilling is not configured");
    this.#session ??= this.options.store.createSession({ owner: "fetch" });
    return this.#session;
  }

  async close(): Promise<void> {
    this.#hashIndexes.clear();
    this.#authorizationKeys.clear();
    if (this.#session !== undefined) await (await this.#session).close();
  }

  hashIndex(
    plan: PhysicalQueryPlan,
    create: () => Promise<SpillableHashIndex<StoredRow>>,
  ): Promise<SpillableHashIndex<StoredRow>> {
    let index = this.#hashIndexes.get(plan);
    if (index === undefined) {
      index = create();
      this.#hashIndexes.set(plan, index);
    }
    return index;
  }

  authorizationKeys(
    plan: PhysicalQueryPlan,
    create: () => Promise<ReadonlySet<string>>,
  ): Promise<ReadonlySet<string>> {
    let keys = this.#authorizationKeys.get(plan);
    if (keys === undefined) {
      keys = create();
      this.#authorizationKeys.set(plan, keys);
    }
    return keys;
  }
}

type SourceRegistry = Readonly<{
  ids: ReadonlyMap<QuerySource, number>;
  sources: readonly QuerySource[];
}>;

function sourceRegistry(plan: PhysicalQueryPlan): SourceRegistry {
  const sources: QuerySource[] = [];
  const visit = (current: PhysicalQueryPlan): void => {
    sources.push(current.source);
    if (current.authorization !== undefined) {
      visit(current.authorization.parent);
    }
    if (current.selection === undefined) return;
    for (const value of Object.values(current.selection)) {
      if (value.kind === "query") visit(value.plan);
    }
  };
  visit(plan);
  return {
    ids: new Map(sources.map((source, index) => [source, index])),
    sources,
  };
}

function keyForRow(table: AnyTable, row: StoredRow): StorageKey {
  return Object.entries(getTableDefinition(table).columns)
    .filter(([, column]) => getColumnDefinition(column).primaryKey)
    .map(([name]) => row[name]);
}

function resolveValue(value: PlannedValue, context: ExecutionContext): unknown {
  if (value.kind === "literal") return value.value;
  return context.get(value.source)?.[value.column];
}

function compareMatches(
  plan: PhysicalQueryPlan,
  left: Match,
  right: Match,
): number {
  for (const order of plan.order) {
    const compared = compareQueryValues(
      evaluateExpressionNode(order.expression, left.context),
      evaluateExpressionNode(order.expression, right.context),
    );
    if (compared !== 0) {
      return order.direction === "asc" ? compared : -compared;
    }
  }
  return left.stableId.localeCompare(right.stableId);
}

function matchCodec(registry: SourceRegistry) {
  return {
    encode(match: Match): Uint8Array {
      return encodeSpillValue({
        stableId: match.stableId,
        row: match.row,
        context: [...match.context].map(([source, row]) => [
          registry.ids.get(source),
          row,
        ]),
      });
    },
    decode(bytes: Uint8Array): Match {
      const decoded = decodeSpillValue(bytes) as {
        stableId: string;
        row: StoredRow;
        context: readonly (readonly [number, StoredRow])[];
      };
      return {
        stableId: decoded.stableId,
        row: decoded.row,
        context: new Map(
          decoded.context.map(([id, row]) => [registry.sources[id]!, row]),
        ),
      };
    },
  };
}

function rowCodec() {
  return {
    encode: (row: StoredRow) => encodeSpillValue(row),
    decode: (bytes: Uint8Array) => decodeSpillValue(bytes) as StoredRow,
  };
}

async function* scanRows(
  plan: PhysicalQueryPlan,
  snapshot: StorageSnapshot,
  parentContext: ExecutionContext,
): AsyncIterable<StoredRow> {
  if (plan.access.kind === "primary-key") {
    const key = plan.access.key.map((value) =>
      resolveValue(value, parentContext),
    );
    if (key.includes(undefined)) return;
    const row = await snapshot.get(plan.access.table, key as StorageKey);
    if (row !== undefined) yield row;
    return;
  }

  const range: StorageRange = {
    reverse: plan.access.reverse,
    ...(plan.access.limit === undefined ? {} : { limit: plan.access.limit }),
  };
  const key =
    plan.access.kind === "index-scan"
      ? plan.access.key.map((value) => resolveValue(value, parentContext))
      : undefined;
  if (key?.includes(undefined)) return;
  const request =
    plan.access.kind === "index-scan"
      ? {
          type: "index" as const,
          table: plan.access.table,
          index: plan.access.index,
          ...(key!.length === 0 ? {} : { key: key as StorageKey }),
          range,
        }
      : { type: "table" as const, table: plan.access.table, range };
  for await (const batch of snapshot.scan(request)) yield* batch;
}

async function executeNode(
  plan: PhysicalQueryPlan,
  snapshot: StorageSnapshot,
  parentContext: ExecutionContext,
  memory: ExecutionMemory,
  spill: QuerySpill,
  registry: SourceRegistry,
  inputRows?: AsyncIterable<StoredRow>,
): Promise<unknown> {
  const matches: Match[] = [];
  const authorizationKeys =
    plan.authorization === undefined
      ? undefined
      : await spill.authorizationKeys(plan.authorization.parent, async () => {
          const result = await executeNode(
            plan.authorization!.parent,
            snapshot,
            new Map(),
            memory,
            spill,
            registry,
          );
          if (!Array.isArray(result)) {
            throw new TypeError("Read-policy parent query must return rows");
          }
          return new Set(
            result.map((row) =>
              encodeStorageKey([
                (row as StoredRow)[plan.authorization!.parentColumn],
              ]),
            ),
          );
        });
  const sorter =
    plan.order.length > 0 && spill.options !== undefined
      ? new SpillableSorter<Match>(
          (left, right) => compareMatches(plan, left, right),
          matchCodec(registry),
          spill.memoryBytes,
          () => spill.session(),
        )
      : undefined;

  for await (const row of inputRows ??
    scanRows(plan, snapshot, parentContext)) {
    memory.add(row, 48);
    if (
      authorizationKeys !== undefined &&
      !authorizationKeys.has(
        encodeStorageKey([row[plan.authorization!.childColumn]]),
      )
    ) {
      continue;
    }
    const context = new Map(parentContext);
    context.set(plan.source, row);
    if (
      !plan.filters.every((filter) =>
        Boolean(evaluateExpressionNode(filter, context)),
      )
    ) {
      continue;
    }
    const match: Match = {
      context,
      row,
      stableId: encodeStorageKey(keyForRow(plan.access.table, row)),
    };
    memory.addBytes(96);
    if (sorter === undefined) matches.push(match);
    else await sorter.push(match);
  }

  if (sorter === undefined && plan.order.length > 0) {
    matches.sort((left, right) => compareMatches(plan, left, right));
  }
  const ordered: AsyncIterable<Match> =
    sorter === undefined
      ? (async function* () {
          yield* matches;
        })()
      : sorter.finish();

  let count = 0;
  const results: unknown[] = [];
  for await (const { context, row } of ordered) {
    if (plan.limit !== undefined && count >= plan.limit) break;
    count += 1;
    if (plan.cardinality === "count" || plan.cardinality === "exists") continue;
    if (plan.selection === undefined) {
      const cloned = structuredClone(row);
      results.push(cloned);
      memory.add(cloned, 32);
      continue;
    }

    const result: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(plan.selection)) {
      result[name] =
        value.kind === "query"
          ? await executeNestedNode(
              value.plan,
              snapshot,
              context,
              memory,
              spill,
              registry,
            )
          : structuredClone(evaluateExpressionNode(value.expression, context));
    }
    results.push(result);
    memory.add(result, 32);
  }

  if (plan.cardinality === "count") return count;
  if (plan.cardinality === "exists") return count > 0;
  switch (plan.cardinality) {
    case "many":
      return results;
    case "one":
      if (results.length > 1) throw new Error("Expected at most one query row");
      return results[0] ?? null;
    case "require":
      if (results.length !== 1) {
        throw new Error("Expected exactly one query row");
      }
      return results[0];
  }
}

async function executeNestedNode(
  plan: PhysicalQueryPlan,
  snapshot: StorageSnapshot,
  parentContext: ExecutionContext,
  memory: ExecutionMemory,
  spill: QuerySpill,
  registry: SourceRegistry,
): Promise<unknown> {
  const join = plan.join;
  if (join?.kind !== "hash") {
    return executeNode(plan, snapshot, parentContext, memory, spill, registry);
  }
  const index = await spill.hashIndex(plan, async () => {
    const created = new SpillableHashIndex<StoredRow>(
      rowCodec(),
      spill.memoryBytes,
      () => spill.session(),
    );
    for await (const row of scanRows(plan, snapshot, new Map())) {
      memory.add(row, 48);
      await created.push(encodeStorageKey([row[join.childColumn]]), row);
    }
    await created.finish();
    return created;
  });
  const key = encodeStorageKey([resolveValue(join.parent, parentContext)]);
  return executeNode(
    plan,
    snapshot,
    parentContext,
    memory,
    spill,
    registry,
    index.lookup(key),
  );
}

export async function executeQueryPlan(
  plan: PhysicalQueryPlan,
  snapshot: StorageSnapshot,
  memoryManager?: MemoryManager,
  spillOptions?: SpillOptions,
): Promise<unknown> {
  const memory = new ExecutionMemory(memoryManager);
  const spill = new QuerySpill(spillOptions);
  try {
    return await executeNode(
      plan,
      snapshot,
      new Map(),
      memory,
      spill,
      sourceRegistry(plan),
    );
  } finally {
    await spill.close();
    memory.release();
  }
}
