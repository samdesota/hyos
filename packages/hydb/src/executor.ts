import type { PhysicalQueryPlan, PlannedValue } from "./planner.js";
import {
  compareQueryValues,
  evaluateExpressionNode,
  type QuerySource,
} from "./query.js";
import type { StorageKey, StorageRange, StorageSnapshot } from "./storage.js";
import {
  estimateMemoryBytes,
  type MemoryHandle,
  type MemoryManager,
} from "./memory.js";

type StoredRow = Readonly<Record<string, unknown>>;
type ExecutionContext = ReadonlyMap<QuerySource, StoredRow>;
type Match = Readonly<{ context: ExecutionContext; row: StoredRow }>;

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

function resolveValue(value: PlannedValue, context: ExecutionContext): unknown {
  if (value.kind === "literal") return value.value;
  return context.get(value.source)?.[value.column];
}

async function executeNode(
  plan: PhysicalQueryPlan,
  snapshot: StorageSnapshot,
  parentContext: ExecutionContext,
  memory: ExecutionMemory,
): Promise<unknown> {
  const rows: StoredRow[] = [];
  if (plan.access.kind === "primary-key") {
    const key = plan.access.key.map((value) =>
      resolveValue(value, parentContext),
    );
    if (!key.includes(undefined)) {
      const row = await snapshot.get(plan.access.table, key as StorageKey);
      if (row !== undefined) {
        rows.push(row);
        memory.add(row, 48);
      }
    }
  } else {
    const range: StorageRange = {
      reverse: plan.access.reverse,
      ...(plan.access.limit === undefined ? {} : { limit: plan.access.limit }),
    };
    const key =
      plan.access.kind === "index-scan"
        ? plan.access.key.map((value) => resolveValue(value, parentContext))
        : undefined;
    if (key === undefined || !key.includes(undefined)) {
      const request =
        plan.access.kind === "index-scan"
          ? {
              type: "index" as const,
              table: plan.access.table,
              index: plan.access.index,
              ...(key!.length === 0 ? {} : { key: key as StorageKey }),
              range,
            }
          : {
              type: "table" as const,
              table: plan.access.table,
              range,
            };
      for await (const batch of snapshot.scan(request)) {
        rows.push(...batch);
        for (const row of batch) memory.add(row, 48);
      }
    }
  }

  let matches: Match[] = rows.map((row) => {
    const context = new Map(parentContext);
    context.set(plan.source, row);
    return { context, row };
  });
  memory.addBytes(matches.length * 96);
  for (const filter of plan.filters) {
    matches = matches.filter(({ context }) =>
      Boolean(evaluateExpressionNode(filter, context)),
    );
  }
  if (plan.order.length > 0) {
    matches.sort((left, right) => {
      for (const order of plan.order) {
        const compared = compareQueryValues(
          evaluateExpressionNode(order.expression, left.context),
          evaluateExpressionNode(order.expression, right.context),
        );
        if (compared !== 0) {
          return order.direction === "asc" ? compared : -compared;
        }
      }
      return 0;
    });
  }
  if (plan.limit !== undefined) matches = matches.slice(0, plan.limit);

  if (plan.cardinality === "count") return matches.length;
  if (plan.cardinality === "exists") return matches.length > 0;

  const results: unknown[] = [];
  for (const { context, row } of matches) {
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
          ? await executeNode(value.plan, snapshot, context, memory)
          : structuredClone(evaluateExpressionNode(value.expression, context));
    }
    results.push(result);
    memory.add(result, 32);
  }

  switch (plan.cardinality) {
    case "many":
      return results;
    case "one":
      if (results.length > 1) throw new Error("Expected at most one query row");
      return results[0] ?? null;
    case "require":
      if (results.length !== 1)
        throw new Error("Expected exactly one query row");
      return results[0];
  }
}

export function executeQueryPlan(
  plan: PhysicalQueryPlan,
  snapshot: StorageSnapshot,
  memoryManager?: MemoryManager,
): Promise<unknown> {
  const memory = new ExecutionMemory(memoryManager);
  return executeNode(plan, snapshot, new Map(), memory).finally(() =>
    memory.release(),
  );
}
