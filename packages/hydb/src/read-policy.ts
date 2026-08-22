import {
  getExpressionNode,
  getQueryPlan,
  queryResult,
  queryRow,
  type BooleanExpression,
  type ExpressionNode,
  type Query,
  type QueryNode,
  type QueryRow,
  type QuerySource,
  type SelectionNode,
} from "./query.js";
import {
  getColumnDefinition,
  getSchemaDefinition,
  getTableDefinition,
  type AnySchema,
  type AnyTable,
  type Column,
} from "./schema.js";
import type { output as ZodOutput, ZodType } from "zod";

const readPolicyDefinition = Symbol("hydb.read-policy");

type WherePolicy<Principal> = Readonly<{
  kind: "where";
  table: AnyTable;
  predicate: (request: {
    row: QueryRow<AnyTable>;
    principal: Principal;
  }) => BooleanExpression;
}>;

type ThroughPolicy = Readonly<{
  kind: "through";
  table: AnyTable;
  parent: AnyTable;
  childColumn: string;
  parentColumn: string;
}>;

type ReadPolicyDefinition<Principal> =
  | Readonly<{ kind: "allow" | "deny"; table: AnyTable }>
  | WherePolicy<Principal>
  | ThroughPolicy;

export type ReadPolicy<Principal> = Readonly<{
  [readPolicyDefinition]: Readonly<{
    principalSchema: ZodType;
    policy: ReadPolicyDefinition<Principal>;
  }>;
}>;

export interface ReadPolicyBuilder<Principal> {
  where<TableValue extends AnyTable>(
    table: TableValue,
    predicate: (request: {
      row: QueryRow<TableValue>;
      principal: Principal;
    }) => BooleanExpression,
  ): ReadPolicy<Principal>;

  through<ChildTable extends AnyTable, ParentTable extends AnyTable, Data>(
    table: ChildTable,
    parent: ParentTable,
    relationship: Readonly<{
      from: Column<Data, boolean, boolean, boolean>;
      to: Column<Data, boolean, boolean, boolean>;
    }>,
  ): ReadPolicy<Principal>;

  allowAll<TableValue extends AnyTable>(
    table: TableValue,
  ): ReadPolicy<Principal>;

  denyAll<TableValue extends AnyTable>(
    table: TableValue,
  ): ReadPolicy<Principal>;
}

function policy<Principal>(
  principalSchema: ZodType,
  definition: ReadPolicyDefinition<Principal>,
): ReadPolicy<Principal> {
  return Object.freeze({
    [readPolicyDefinition]: Object.freeze({
      principalSchema,
      policy: Object.freeze(definition),
    }),
  });
}

export function readPolicy<PrincipalSchema extends ZodType>(
  principalSchema: PrincipalSchema,
): ReadPolicyBuilder<ZodOutput<PrincipalSchema>> {
  type Principal = ZodOutput<PrincipalSchema>;
  return Object.freeze({
    where<TableValue extends AnyTable>(
      table: TableValue,
      predicate: (request: {
        row: QueryRow<TableValue>;
        principal: Principal;
      }) => BooleanExpression,
    ) {
      return policy(principalSchema, {
        kind: "where",
        table,
        predicate: predicate as WherePolicy<Principal>["predicate"],
      });
    },

    through<ChildTable extends AnyTable, ParentTable extends AnyTable, Data>(
      table: ChildTable,
      parent: ParentTable,
      relationship: Readonly<{
        from: Column<Data, boolean, boolean, boolean>;
        to: Column<Data, boolean, boolean, boolean>;
      }>,
    ) {
      const child = getColumnDefinition(relationship.from);
      const target = getColumnDefinition(relationship.to);
      if (child.tableName !== getTableDefinition(table).name) {
        throw new TypeError(
          "Read-policy relationship starts outside its table",
        );
      }
      if (target.tableName !== getTableDefinition(parent).name) {
        throw new TypeError("Read-policy relationship ends outside its parent");
      }
      if (child.dataType !== target.dataType) {
        throw new TypeError(
          "Read-policy relationship columns must have the same data type",
        );
      }
      const primaryKeys = Object.values(getTableDefinition(parent).columns)
        .filter((column) => getColumnDefinition(column).primaryKey)
        .map((column) => getColumnDefinition(column).name);
      if (primaryKeys.length !== 1 || primaryKeys[0] !== target.name) {
        throw new TypeError(
          "Read-policy relationships must target a single-column primary key",
        );
      }
      return policy(principalSchema, {
        kind: "through",
        table,
        parent,
        childColumn: child.name,
        parentColumn: target.name,
      });
    },

    allowAll<TableValue extends AnyTable>(table: TableValue) {
      return policy(principalSchema, { kind: "allow", table });
    },

    denyAll<TableValue extends AnyTable>(table: TableValue) {
      return policy(principalSchema, { kind: "deny", table });
    },
  });
}

type AuthorizationFact = Readonly<{
  table: string;
  source: QuerySource;
}>;

function assertNever(value: never): never {
  throw new TypeError(`Unsupported query source: ${String(value)}`);
}

function conjunctions(expression: ExpressionNode): readonly ExpressionNode[] {
  return expression.type === "logical" && expression.operator === "and"
    ? [...conjunctions(expression.left), ...conjunctions(expression.right)]
    : [expression];
}

function provesRelationship(
  node: QueryNode,
  fact: AuthorizationFact,
  childColumn: string,
  parentColumn: string,
): boolean {
  return node.filters.flatMap(conjunctions).some((expression) => {
    if (expression.type !== "comparison" || expression.operator !== "eq") {
      return false;
    }
    const matches = (left: ExpressionNode, right: ExpressionNode) =>
      left.type === "field" &&
      left.source === node.source &&
      left.column === childColumn &&
      right.type === "field" &&
      right.source === fact.source &&
      right.column === parentColumn;
    return (
      matches(expression.left, expression.right) ||
      matches(expression.right, expression.left)
    );
  });
}

class ReadPolicyEnforcer<Principal> {
  readonly #catalog = new Map<string, ReadPolicyDefinition<Principal>>();

  constructor(schema: AnySchema, policies: readonly ReadPolicy<Principal>[]) {
    const schemaTables = new Map(
      Object.values(getSchemaDefinition(schema).tables).map((table) => [
        getTableDefinition(table).name,
        table,
      ]),
    );
    for (const value of policies) {
      const definition = value[readPolicyDefinition].policy;
      const name = getTableDefinition(definition.table).name;
      if (schemaTables.get(name) !== definition.table) {
        throw new TypeError(
          `Read policy references a table outside the schema: ${name}`,
        );
      }
      if (definition.kind === "through") {
        const parentName = getTableDefinition(definition.parent).name;
        if (schemaTables.get(parentName) !== definition.parent) {
          throw new TypeError(
            `Read policy references a parent outside the schema: ${parentName}`,
          );
        }
      }
      if (this.#catalog.has(name)) {
        throw new TypeError(`Duplicate read policy for table: ${name}`);
      }
      this.#catalog.set(name, definition);
    }
    for (const name of schemaTables.keys()) {
      if (!this.#catalog.has(name)) {
        throw new TypeError(`Missing read policy for table: ${name}`);
      }
    }
    this.assertAcyclic();
  }

  authorize<QueryValue extends Query<any>>(
    query: QueryValue,
    principal: Principal,
  ): QueryValue {
    return queryResult(
      this.authorizeNode(getQueryPlan(query), principal, [], []),
    ) as QueryValue;
  }

  private authorizeNode(
    node: QueryNode,
    principal: Principal,
    facts: readonly AuthorizationFact[],
    stack: readonly string[],
  ): QueryNode {
    const sourceKind = node.source.kind;
    switch (sourceKind) {
      case "table":
        break;
      default:
        assertNever(sourceKind);
    }
    const table = node.source.table;
    const definition = this.#catalog.get(table);
    if (definition === undefined) {
      throw new TypeError(`Missing read policy for query source: ${table}`);
    }
    if (stack.includes(table)) {
      throw new TypeError(
        `Cyclic read policy while authorizing table: ${table}`,
      );
    }

    const filters = [...node.filters];
    let authorization = node.authorization;
    if (definition.kind === "deny") {
      filters.push(Object.freeze({ type: "literal", value: false }));
    } else if (definition.kind === "where") {
      filters.push(
        getExpressionNode(
          definition.predicate({
            row: queryRow(definition.table, node.source),
            principal,
          }),
        ),
      );
    } else if (definition.kind === "through") {
      const proof = facts.find(
        (fact) =>
          fact.table === getTableDefinition(definition.parent).name &&
          provesRelationship(
            node,
            fact,
            definition.childColumn,
            definition.parentColumn,
          ),
      );
      if (proof === undefined) {
        const parentSource = Object.freeze({
          kind: "table" as const,
          table: getTableDefinition(definition.parent).name,
        });
        const parent = this.authorizeNode(
          Object.freeze({
            source: parentSource,
            filters: Object.freeze([]),
            order: Object.freeze([]),
            cardinality: "many" as const,
          }),
          principal,
          [],
          [...stack, table],
        );
        authorization = Object.freeze({
          kind: "through" as const,
          parent,
          childColumn: definition.childColumn,
          parentColumn: definition.parentColumn,
        });
      }
    }

    const childFacts = [
      ...facts,
      Object.freeze({ table, source: node.source }),
    ];
    const selection =
      node.selection === undefined
        ? undefined
        : (Object.freeze(
            Object.fromEntries(
              Object.entries(node.selection).map(([name, value]) => [
                name,
                "source" in value && "filters" in value
                  ? this.authorizeNode(value, principal, childFacts, [])
                  : value,
              ]),
            ),
          ) as SelectionNode);

    return Object.freeze({
      ...node,
      filters: Object.freeze(filters),
      ...(selection === undefined ? {} : { selection }),
      ...(authorization === undefined ? {} : { authorization }),
    });
  }

  private assertAcyclic(): void {
    const visit = (table: string, stack: readonly string[]): void => {
      if (stack.includes(table)) {
        throw new TypeError(`Cyclic read policy involving table: ${table}`);
      }
      const definition = this.#catalog.get(table);
      if (definition?.kind !== "through") return;
      visit(getTableDefinition(definition.parent).name, [...stack, table]);
    };
    for (const table of this.#catalog.keys()) visit(table, []);
  }
}

export function createReadPolicyEnforcer<Principal>(
  schema: AnySchema,
  principalSchema: ZodType,
  policies: readonly ReadPolicy<Principal>[],
): Readonly<{
  authorize<QueryValue extends Query<any>>(
    query: QueryValue,
    principal: Principal,
  ): QueryValue;
}> {
  for (const policy of policies) {
    if (policy[readPolicyDefinition].principalSchema !== principalSchema) {
      throw new TypeError(
        "Read policies must use the gateway's principal schema",
      );
    }
  }
  const enforcer = new ReadPolicyEnforcer(schema, policies);
  return Object.freeze({
    authorize: <QueryValue extends Query<any>>(
      query: QueryValue,
      principal: Principal,
    ) => enforcer.authorize(query, principal),
  });
}
