import {
  getQueryPlan,
  type ExpressionNode,
  type Query,
  type QueryPlan,
  type QuerySource,
} from "./query.js";
import {
  getColumnDefinition,
  getIndexDefinition,
  getSchemaDefinition,
  getTableDefinition,
  type AnySchema,
  type AnyTable,
  type IndexDefinition,
} from "./schema.js";

export type PlannedValue =
  | Readonly<{ kind: "literal"; value: unknown }>
  | Readonly<{
      kind: "outer-field";
      source: QuerySource;
      column: string;
    }>;

export type PhysicalAccess =
  | Readonly<{
      kind: "primary-key";
      table: AnyTable;
      key: readonly PlannedValue[];
    }>
  | Readonly<{
      kind: "table-scan";
      table: AnyTable;
      reverse: boolean;
      limit?: number;
    }>
  | Readonly<{
      kind: "index-scan";
      table: AnyTable;
      index: string;
      key: readonly PlannedValue[];
      reverse: boolean;
      limit?: number;
    }>;

export type PhysicalQueryPlan = Readonly<{
  source: QuerySource;
  access: PhysicalAccess;
  filters: readonly ExpressionNode[];
  order: QueryPlan["order"];
  limit?: number;
  cardinality: NonNullable<QueryPlan["cardinality"]>;
  selection?: PlannedSelection;
}>;

export type PlannedSelectionValue =
  | Readonly<{ kind: "expression"; expression: ExpressionNode }>
  | Readonly<{ kind: "query"; plan: PhysicalQueryPlan }>;

export type PlannedSelection = Readonly<Record<string, PlannedSelectionValue>>;

type Equality = Readonly<{
  column: string;
  value: PlannedValue;
  expression: ExpressionNode;
}>;

type IndexCandidate = Readonly<{
  definition: IndexDefinition;
  equalities: readonly Equality[];
  orderCovered: boolean;
  reverse: boolean;
  uniqueExact: boolean;
}>;

function flattenConjunction(expression: ExpressionNode): ExpressionNode[] {
  return expression.type === "logical" && expression.operator === "and"
    ? [
        ...flattenConjunction(expression.left),
        ...flattenConjunction(expression.right),
      ]
    : [expression];
}

function plannedValue(
  expression: ExpressionNode,
  localSource: QuerySource,
): PlannedValue | undefined {
  if (expression.type === "literal") {
    return Object.freeze({ kind: "literal", value: expression.value });
  }
  if (expression.type === "field" && expression.source !== localSource) {
    return Object.freeze({
      kind: "outer-field",
      source: expression.source,
      column: expression.column,
    });
  }
  return undefined;
}

function equalityFor(
  expression: ExpressionNode,
  localSource: QuerySource,
): Equality | undefined {
  if (expression.type !== "comparison" || expression.operator !== "eq") {
    return undefined;
  }
  if (
    expression.left.type === "field" &&
    expression.left.source === localSource
  ) {
    const value = plannedValue(expression.right, localSource);
    return value === undefined
      ? undefined
      : { column: expression.left.column, value, expression };
  }
  if (
    expression.right.type === "field" &&
    expression.right.source === localSource
  ) {
    const value = plannedValue(expression.left, localSource);
    return value === undefined
      ? undefined
      : { column: expression.right.column, value, expression };
  }
  return undefined;
}

function tableFor(schema: AnySchema, name: string): AnyTable {
  const table = Object.values(getSchemaDefinition(schema).tables).find(
    (candidate) => getTableDefinition(candidate).name === name,
  );
  if (table === undefined) throw new TypeError(`Unknown query table: ${name}`);
  return table;
}

function indexCandidate(
  definition: IndexDefinition,
  equalityByColumn: ReadonlyMap<string, Equality>,
  order: QueryPlan["order"],
  localSource: QuerySource,
): IndexCandidate | undefined {
  const metadata = getIndexDefinition(definition);
  const columnNames = metadata.columns.map(
    (column) => getColumnDefinition(column).name,
  );
  const equalities: Equality[] = [];
  for (const column of columnNames) {
    const equality = equalityByColumn.get(column);
    if (equality === undefined) break;
    equalities.push(equality);
  }

  const remainingOrder = order.filter((item) => {
    const expression = item.expression;
    return !(
      expression.type === "field" &&
      expression.source === localSource &&
      equalityByColumn.has(expression.column)
    );
  });
  const directions = new Set(remainingOrder.map((item) => item.direction));
  const orderCovered =
    directions.size <= 1 &&
    remainingOrder.every((item, position) => {
      const expression = item.expression;
      return (
        expression.type === "field" &&
        expression.source === localSource &&
        expression.column === columnNames[equalities.length + position]
      );
    });

  if (equalities.length === 0 && (order.length === 0 || !orderCovered)) {
    return undefined;
  }
  return {
    definition,
    equalities,
    orderCovered,
    reverse:
      remainingOrder.length > 0 && remainingOrder[0]!.direction === "desc",
    uniqueExact: metadata.unique && equalities.length === columnNames.length,
  };
}

function compareCandidates(
  left: IndexCandidate,
  right: IndexCandidate,
): number {
  if (left.uniqueExact !== right.uniqueExact) return left.uniqueExact ? -1 : 1;
  if (left.equalities.length !== right.equalities.length) {
    return right.equalities.length - left.equalities.length;
  }
  if (left.orderCovered !== right.orderCovered) {
    return left.orderCovered ? -1 : 1;
  }
  return 0;
}

function coversColumnOrder(
  order: QueryPlan["order"],
  localSource: QuerySource,
  columns: readonly string[],
): Readonly<{ covered: boolean; reverse: boolean }> {
  const directions = new Set(order.map((item) => item.direction));
  const covered =
    directions.size <= 1 &&
    order.every((item, position) => {
      const expression = item.expression;
      return (
        expression.type === "field" &&
        expression.source === localSource &&
        expression.column === columns[position]
      );
    });
  return {
    covered,
    reverse: order.length > 0 && order[0]!.direction === "desc",
  };
}

export function planQuery(
  schema: AnySchema,
  query: Query<unknown>,
): PhysicalQueryPlan {
  return planNode(schema, getQueryPlan(query));
}

function isQueryPlan(value: ExpressionNode | QueryPlan): value is QueryPlan {
  return "source" in value && "filters" in value;
}

function planNode(schema: AnySchema, logical: QueryPlan): PhysicalQueryPlan {
  const table = tableFor(schema, logical.source.table);
  const cardinality = logical.cardinality ?? "many";
  const cardinalityLimit =
    cardinality === "exists"
      ? 1
      : cardinality === "one" || cardinality === "require"
        ? 2
        : undefined;
  const scanLimit =
    cardinalityLimit === undefined
      ? logical.limit
      : Math.min(logical.limit ?? cardinalityLimit, cardinalityLimit);
  const filters = logical.filters.flatMap(flattenConjunction);
  const equalities = filters
    .map((filter) => equalityFor(filter, logical.source))
    .filter((value): value is Equality => value !== undefined);
  const equalityByColumn = new Map<string, Equality>();
  for (const equality of equalities) {
    if (!equalityByColumn.has(equality.column)) {
      equalityByColumn.set(equality.column, equality);
    }
  }

  const primaryColumns = Object.values(getTableDefinition(table).columns)
    .filter((column) => getColumnDefinition(column).primaryKey)
    .map((column) => getColumnDefinition(column).name);
  const primaryEqualities = primaryColumns.map((column) =>
    equalityByColumn.get(column),
  );
  const used = new Set<ExpressionNode>();
  let access: PhysicalAccess;
  let orderCovered = false;
  if (primaryEqualities.every((value) => value !== undefined)) {
    for (const equality of primaryEqualities) used.add(equality!.expression);
    access = Object.freeze({
      kind: "primary-key",
      table,
      key: Object.freeze(primaryEqualities.map((value) => value!.value)),
    });
    orderCovered = true;
  } else {
    const candidate = getTableDefinition(table)
      .indexes.map((definition) =>
        indexCandidate(
          definition,
          equalityByColumn,
          logical.order,
          logical.source,
        ),
      )
      .filter((value): value is IndexCandidate => value !== undefined)
      .sort(compareCandidates)[0];
    if (candidate === undefined) {
      const tableOrder = coversColumnOrder(
        logical.order,
        logical.source,
        primaryColumns,
      );
      orderCovered = tableOrder.covered;
      access = Object.freeze({
        kind: "table-scan",
        table,
        reverse: tableOrder.covered && tableOrder.reverse,
        ...(scanLimit !== undefined &&
        filters.length === 0 &&
        tableOrder.covered
          ? { limit: scanLimit }
          : {}),
      });
    } else {
      for (const equality of candidate.equalities) {
        used.add(equality.expression);
      }
      orderCovered = candidate.orderCovered;
      const residualFilters = filters.filter((filter) => !used.has(filter));
      access = Object.freeze({
        kind: "index-scan",
        table,
        index: getIndexDefinition(candidate.definition).name,
        key: Object.freeze(candidate.equalities.map(({ value }) => value)),
        reverse: candidate.reverse,
        ...(scanLimit !== undefined &&
        residualFilters.length === 0 &&
        orderCovered
          ? { limit: scanLimit }
          : {}),
      });
    }
  }

  return Object.freeze({
    source: logical.source,
    access,
    filters: Object.freeze(filters.filter((filter) => !used.has(filter))),
    order: orderCovered ? Object.freeze([]) : logical.order,
    ...(logical.limit === undefined ? {} : { limit: logical.limit }),
    cardinality,
    ...(logical.selection === undefined
      ? {}
      : {
          selection: Object.freeze(
            Object.fromEntries(
              Object.entries(logical.selection).map(([name, value]) => [
                name,
                isQueryPlan(value)
                  ? Object.freeze({
                      kind: "query",
                      plan: planNode(schema, value),
                    })
                  : Object.freeze({ kind: "expression", expression: value }),
              ]),
            ),
          ),
        }),
  });
}
