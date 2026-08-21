import type { PhysicalQueryPlan, PlannedValue } from "./planner.js";
import {
  compareQueryValues,
  evaluateExpressionNode,
  type QuerySource,
} from "./query.js";
import type { StorageKey, StorageRange, StorageSnapshot } from "./storage.js";

type StoredRow = Readonly<Record<string, unknown>>;
type ExecutionContext = ReadonlyMap<QuerySource, StoredRow>;
type Match = Readonly<{ context: ExecutionContext; row: StoredRow }>;

function resolveValue(value: PlannedValue, context: ExecutionContext): unknown {
  if (value.kind === "literal") return value.value;
  return context.get(value.source)?.[value.column];
}

async function executeNode(
  plan: PhysicalQueryPlan,
  snapshot: StorageSnapshot,
  parentContext: ExecutionContext,
): Promise<unknown> {
  const rows: StoredRow[] = [];
  if (plan.access.kind === "primary-key") {
    const key = plan.access.key.map((value) =>
      resolveValue(value, parentContext),
    );
    if (!key.includes(undefined)) {
      const row = await snapshot.get(plan.access.table, key as StorageKey);
      if (row !== undefined) rows.push(row);
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
      for await (const batch of snapshot.scan(request)) rows.push(...batch);
    }
  }

  let matches: Match[] = rows.map((row) => {
    const context = new Map(parentContext);
    context.set(plan.source, row);
    return { context, row };
  });
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
      results.push(structuredClone(row));
      continue;
    }

    const result: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(plan.selection)) {
      result[name] =
        value.kind === "query"
          ? await executeNode(value.plan, snapshot, context)
          : structuredClone(evaluateExpressionNode(value.expression, context));
    }
    results.push(result);
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
): Promise<unknown> {
  return executeNode(plan, snapshot, new Map());
}
