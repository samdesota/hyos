import { getTableDefinition, type AnyTable, type InferRow } from "./schema.js";

const expressionDefinition = Symbol("hydb.expression");
const queryDefinition = Symbol("hydb.query");

export type QuerySource = Readonly<{
  table: string;
}>;

export type FieldNode = Readonly<{
  type: "field";
  source: QuerySource;
  column: string;
}>;

export type LiteralNode = Readonly<{
  type: "literal";
  value: unknown;
}>;

export type ComparisonNode = Readonly<{
  type: "comparison";
  operator: "eq" | "ne";
  left: ExpressionNode;
  right: ExpressionNode;
}>;

export type LogicalNode = Readonly<{
  type: "logical";
  operator: "and" | "or";
  left: ExpressionNode;
  right: ExpressionNode;
}>;

export type NotNode = Readonly<{
  type: "not";
  value: ExpressionNode;
}>;

export type ExpressionNode =
  FieldNode | LiteralNode | ComparisonNode | LogicalNode | NotNode;

export type OrderNode = Readonly<{
  expression: ExpressionNode;
  direction: "asc" | "desc";
}>;

export type SelectionNode = Readonly<
  Record<string, ExpressionNode | QueryNode>
>;

export type QueryPlan = Readonly<{
  source: QuerySource;
  filters: readonly ExpressionNode[];
  order: readonly OrderNode[];
  limit?: number;
  selection?: SelectionNode;
  cardinality?: "many" | "one" | "require" | "exists" | "count";
}>;

export type QueryNode = QueryPlan;

export type Expression<Data> = Readonly<{
  [expressionDefinition]: {
    data: Data;
    node: ExpressionNode;
  };
}>;

export type BooleanExpression = Expression<boolean> &
  Readonly<{
    and(other: BooleanExpression): BooleanExpression;
    or(other: BooleanExpression): BooleanExpression;
    not(): BooleanExpression;
  }>;

export type OrderExpression = Readonly<{
  node: OrderNode;
}>;

export type FieldExpression<Data> = Expression<Data> &
  Readonly<{
    eq(value: Data | Expression<Data>): BooleanExpression;
    ne(value: Data | Expression<Data>): BooleanExpression;
    asc(): OrderExpression;
    desc(): OrderExpression;
  }>;

type QueryRow<TableValue extends AnyTable> = {
  readonly [Key in keyof InferRow<TableValue>]: FieldExpression<
    InferRow<TableValue>[Key]
  >;
};

type Selectable = Expression<any> | Query<any>;
type SelectionShape = Readonly<Record<string, Selectable>>;

type InferSelection<Selection extends SelectionShape> = {
  -readonly [Key in keyof Selection]: Selection[Key] extends Expression<
    infer Data
  >
    ? Data
    : Selection[Key] extends Query<infer Result>
      ? Result
      : never;
};

export type Query<Result> = Readonly<{
  [queryDefinition]: {
    result: Result;
    node: QueryNode;
  };
}>;

export type InferQueryResult<QueryValue extends Query<any>> =
  QueryValue extends Query<infer Result> ? Result : never;

function isExpression(value: unknown): value is Expression<unknown> {
  return (
    typeof value === "object" && value !== null && expressionDefinition in value
  );
}

function isQuery(value: unknown): value is Query<unknown> {
  return (
    typeof value === "object" && value !== null && queryDefinition in value
  );
}

function nodeOf(value: unknown): ExpressionNode {
  if (isExpression(value)) return value[expressionDefinition].node;
  return Object.freeze({ type: "literal", value });
}

function booleanExpression(node: ExpressionNode): BooleanExpression {
  const definition = Object.freeze({
    data: undefined as unknown as boolean,
    node,
  });
  return Object.freeze({
    [expressionDefinition]: definition,
    and(other: BooleanExpression) {
      return booleanExpression(
        Object.freeze({
          type: "logical",
          operator: "and",
          left: node,
          right: other[expressionDefinition].node,
        }),
      );
    },
    or(other: BooleanExpression) {
      return booleanExpression(
        Object.freeze({
          type: "logical",
          operator: "or",
          left: node,
          right: other[expressionDefinition].node,
        }),
      );
    },
    not() {
      return booleanExpression(Object.freeze({ type: "not", value: node }));
    },
  });
}

function field<Data>(
  source: QuerySource,
  column: string,
): FieldExpression<Data> {
  const node: FieldNode = Object.freeze({ type: "field", source, column });
  const definition = Object.freeze({ data: undefined as Data, node });

  function compare(
    operator: ComparisonNode["operator"],
    value: Data | Expression<Data>,
  ): BooleanExpression {
    return booleanExpression(
      Object.freeze({
        type: "comparison",
        operator,
        left: node,
        right: nodeOf(value),
      }),
    );
  }

  return Object.freeze({
    [expressionDefinition]: definition,
    eq(value: Data | Expression<Data>) {
      return compare("eq", value);
    },
    ne(value: Data | Expression<Data>) {
      return compare("ne", value);
    },
    asc() {
      return Object.freeze({
        node: Object.freeze({ expression: node, direction: "asc" }),
      });
    },
    desc() {
      return Object.freeze({
        node: Object.freeze({ expression: node, direction: "desc" }),
      });
    },
  });
}

function queryRow<TableValue extends AnyTable>(
  table: TableValue,
  source: QuerySource,
): QueryRow<TableValue> {
  const definition = getTableDefinition(table);
  return Object.freeze(
    Object.fromEntries(
      Object.keys(definition.columns).map((column) => [
        column,
        field(source, column),
      ]),
    ),
  ) as QueryRow<TableValue>;
}

function queryResult<Result>(node: QueryNode): Query<Result> {
  return Object.freeze({
    [queryDefinition]: Object.freeze({ result: undefined as Result, node }),
  });
}

function selectionNode(selection: SelectionShape): SelectionNode {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(selection).map(([name, value]) => {
        if (isExpression(value)) {
          return [name, value[expressionDefinition].node];
        }
        if (isQuery(value)) {
          return [name, value[queryDefinition].node];
        }
        throw new TypeError(`Invalid selection for ${name}`);
      }),
    ),
  );
}

export class QueryBuilder<TableValue extends AnyTable, Result> {
  readonly #tableValue: TableValue;
  readonly #row: QueryRow<TableValue>;
  readonly #node: QueryNode;

  constructor(table: TableValue, node?: QueryNode) {
    this.#tableValue = table;
    const source =
      node?.source ?? Object.freeze({ table: getTableDefinition(table).name });
    this.#row = queryRow(table, source);
    this.#node =
      node ??
      Object.freeze({
        source,
        filters: Object.freeze([]),
        order: Object.freeze([]),
      });
  }

  where(
    predicate: (row: QueryRow<TableValue>) => BooleanExpression,
  ): QueryBuilder<TableValue, Result> {
    const expression = predicate(this.#row);
    return new QueryBuilder<TableValue, Result>(
      this.#tableValue,
      Object.freeze({
        ...this.#node,
        filters: Object.freeze([
          ...this.#node.filters,
          expression[expressionDefinition].node,
        ]),
      }),
    );
  }

  orderBy(
    ordering: (
      row: QueryRow<TableValue>,
    ) => OrderExpression | readonly OrderExpression[],
  ): QueryBuilder<TableValue, Result> {
    const result = ordering(this.#row);
    const orders = Array.isArray(result) ? result : [result];
    return new QueryBuilder<TableValue, Result>(
      this.#tableValue,
      Object.freeze({
        ...this.#node,
        order: Object.freeze(orders.map((order) => order.node)),
      }),
    );
  }

  limit(count: number): QueryBuilder<TableValue, Result> {
    return new QueryBuilder<TableValue, Result>(
      this.#tableValue,
      Object.freeze({ ...this.#node, limit: count }),
    );
  }

  select<const Selection extends SelectionShape>(
    projection: (row: QueryRow<TableValue>) => Selection,
  ): QueryBuilder<TableValue, InferSelection<Selection>> {
    return new QueryBuilder<TableValue, InferSelection<Selection>>(
      this.#tableValue,
      Object.freeze({
        ...this.#node,
        selection: selectionNode(projection(this.#row)),
      }),
    );
  }

  many(): Query<Result[]> {
    return queryResult(Object.freeze({ ...this.#node, cardinality: "many" }));
  }

  one(): Query<Result | null> {
    return queryResult(Object.freeze({ ...this.#node, cardinality: "one" }));
  }

  require(): Query<Result> {
    return queryResult(
      Object.freeze({ ...this.#node, cardinality: "require" }),
    );
  }

  exists(): Query<boolean> {
    return queryResult(Object.freeze({ ...this.#node, cardinality: "exists" }));
  }

  count(): Query<number> {
    return queryResult(Object.freeze({ ...this.#node, cardinality: "count" }));
  }
}

export function query<TableValue extends AnyTable>(
  table: TableValue,
): QueryBuilder<TableValue, InferRow<TableValue>> {
  return new QueryBuilder(table);
}

export function getQueryPlan<QueryValue extends Query<any>>(
  value: QueryValue,
): QueryPlan {
  return value[queryDefinition].node;
}

type QueryRowValue = Readonly<Record<string, unknown>>;
type EvaluationContext = ReadonlyMap<QuerySource, QueryRowValue>;

export type QueryDataSource = Readonly<{
  rows(table: string): readonly QueryRowValue[];
  lookup?(
    table: string,
    column: string,
    value: unknown,
  ): readonly QueryRowValue[] | undefined;
}>;

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  return Object.is(left, right);
}

export function evaluateExpressionNode(
  node: ExpressionNode,
  context: EvaluationContext,
): unknown {
  switch (node.type) {
    case "field":
      return context.get(node.source)?.[node.column];
    case "literal":
      return node.value;
    case "comparison": {
      const equal = valuesEqual(
        evaluateExpressionNode(node.left, context),
        evaluateExpressionNode(node.right, context),
      );
      return node.operator === "eq" ? equal : !equal;
    }
    case "logical": {
      const left = Boolean(evaluateExpressionNode(node.left, context));
      return node.operator === "and"
        ? left && Boolean(evaluateExpressionNode(node.right, context))
        : left || Boolean(evaluateExpressionNode(node.right, context));
    }
    case "not":
      return !Boolean(evaluateExpressionNode(node.value, context));
  }
}

export function compareQueryValues(left: unknown, right: unknown): number {
  if (valuesEqual(left, right)) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  const leftValue = left instanceof Date ? left.getTime() : left;
  const rightValue = right instanceof Date ? right.getTime() : right;
  if (
    (typeof leftValue === "number" && typeof rightValue === "number") ||
    (typeof leftValue === "string" && typeof rightValue === "string") ||
    (typeof leftValue === "boolean" && typeof rightValue === "boolean")
  ) {
    return leftValue < rightValue ? -1 : 1;
  }
  throw new TypeError("Values cannot be ordered");
}

export function isQueryNode(
  node: ExpressionNode | QueryNode,
): node is QueryNode {
  return "filters" in node;
}

export function expressionReferencesSource(
  node: ExpressionNode,
  source: QuerySource,
): boolean {
  switch (node.type) {
    case "field":
      return node.source === source;
    case "literal":
      return false;
    case "comparison":
    case "logical":
      return (
        expressionReferencesSource(node.left, source) ||
        expressionReferencesSource(node.right, source)
      );
    case "not":
      return expressionReferencesSource(node.value, source);
  }
}

function lookupRows(
  node: QueryNode,
  source: QueryDataSource,
  parentContext: EvaluationContext,
): readonly QueryRowValue[] {
  if (source.lookup === undefined) return source.rows(node.source.table);

  for (const filter of node.filters) {
    if (filter.type !== "comparison" || filter.operator !== "eq") continue;

    if (
      filter.left.type === "field" &&
      filter.left.source === node.source &&
      !expressionReferencesSource(filter.right, node.source)
    ) {
      const rows = source.lookup(
        node.source.table,
        filter.left.column,
        evaluateExpressionNode(filter.right, parentContext),
      );
      if (rows !== undefined) return rows;
    }

    if (
      filter.right.type === "field" &&
      filter.right.source === node.source &&
      !expressionReferencesSource(filter.left, node.source)
    ) {
      const rows = source.lookup(
        node.source.table,
        filter.right.column,
        evaluateExpressionNode(filter.left, parentContext),
      );
      if (rows !== undefined) return rows;
    }
  }

  return source.rows(node.source.table);
}

function evaluateNode(
  node: QueryNode,
  source: QueryDataSource,
  parentContext: EvaluationContext,
): unknown {
  let matches = lookupRows(node, source, parentContext).map((row) => {
    const context = new Map(parentContext);
    context.set(node.source, row);
    return { context, row };
  });

  for (const filter of node.filters) {
    matches = matches.filter((match) =>
      Boolean(evaluateExpressionNode(filter, match.context)),
    );
  }

  if (node.order.length > 0) {
    matches.sort((left, right) => {
      for (const order of node.order) {
        const comparison = compareQueryValues(
          evaluateExpressionNode(order.expression, left.context),
          evaluateExpressionNode(order.expression, right.context),
        );
        if (comparison !== 0) {
          return order.direction === "asc" ? comparison : -comparison;
        }
      }
      return 0;
    });
  }

  if (node.limit !== undefined) matches = matches.slice(0, node.limit);

  if (node.cardinality === "count") return matches.length;
  if (node.cardinality === "exists") return matches.length > 0;

  const results = matches.map(({ context, row }) => {
    if (node.selection === undefined) return structuredClone(row);
    return Object.fromEntries(
      Object.entries(node.selection).map(([name, value]) => [
        name,
        isQueryNode(value)
          ? evaluateNode(value, source, context)
          : structuredClone(evaluateExpressionNode(value, context)),
      ]),
    );
  });

  switch (node.cardinality) {
    case "many":
      return results;
    case "one":
      if (results.length > 1) throw new Error("Expected at most one query row");
      return results[0] ?? null;
    case "require":
      if (results.length !== 1)
        throw new Error("Expected exactly one query row");
      return results[0];
    default:
      throw new Error("Query cardinality is required");
  }
}

export function evaluateQuery<QueryValue extends Query<any>>(
  value: QueryValue,
  source: QueryDataSource,
): InferQueryResult<QueryValue> {
  return evaluateNode(
    getQueryPlan(value),
    source,
    new Map(),
  ) as InferQueryResult<QueryValue>;
}

function collectQueryTables(node: QueryNode, tables: Set<string>): void {
  tables.add(node.source.table);
  if (node.selection === undefined) return;
  for (const value of Object.values(node.selection)) {
    if (isQueryNode(value)) collectQueryTables(value, tables);
  }
}

export function getQueryTables<QueryValue extends Query<any>>(
  value: QueryValue,
): ReadonlySet<string> {
  const tables = new Set<string>();
  collectQueryTables(getQueryPlan(value), tables);
  return tables;
}
