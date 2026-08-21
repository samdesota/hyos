import { getTableDefinition, type AnyTable, type InferRow } from "./schema.js";

const expressionDefinition = Symbol("hydb.expression");
const queryDefinition = Symbol("hydb.query");

type QuerySource = Readonly<{
  table: string;
}>;

type FieldNode = Readonly<{
  type: "field";
  source: QuerySource;
  column: string;
}>;

type LiteralNode = Readonly<{
  type: "literal";
  value: unknown;
}>;

type ComparisonNode = Readonly<{
  type: "comparison";
  operator: "eq" | "ne";
  left: ExpressionNode;
  right: ExpressionNode;
}>;

type LogicalNode = Readonly<{
  type: "logical";
  operator: "and" | "or";
  left: ExpressionNode;
  right: ExpressionNode;
}>;

type NotNode = Readonly<{
  type: "not";
  value: ExpressionNode;
}>;

type ExpressionNode =
  FieldNode | LiteralNode | ComparisonNode | LogicalNode | NotNode;

type OrderNode = Readonly<{
  expression: ExpressionNode;
  direction: "asc" | "desc";
}>;

type SelectionNode = Readonly<Record<string, ExpressionNode | QueryNode>>;

export type QueryPlan = Readonly<{
  source: QuerySource;
  filters: readonly ExpressionNode[];
  order: readonly OrderNode[];
  limit?: number;
  selection?: SelectionNode;
  cardinality?: "many" | "one" | "require" | "exists" | "count";
}>;

type QueryNode = QueryPlan;

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
