import type { output as ZodOutput, ZodType } from "zod";

import {
  getColumnDefinition,
  getSchemaDefinition,
  getTableDefinition,
  type AnySchema,
  type AnyTable,
  type Column,
  type InferRow,
} from "./schema.js";
import type { StorageKey } from "./storage.js";

const writePolicyDefinition = Symbol("hydb.write-policy");

export type WriteChange<Row> =
  | Readonly<{ kind: "insert"; after: Row }>
  | Readonly<{ kind: "update"; before: Row; after: Row }>
  | Readonly<{ kind: "delete"; before: Row }>;

export interface TransactionReader {
  get<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): Promise<InferRow<TableValue> | undefined>;
}

type WherePolicy<Principal> = Readonly<{
  kind: "where";
  table: AnyTable;
  authorize: (request: {
    change: WriteChange<Readonly<Record<string, unknown>>>;
    principal: Principal;
    db: TransactionReader;
  }) => boolean | PromiseLike<boolean>;
}>;

type ThroughPolicy = Readonly<{
  kind: "through";
  table: AnyTable;
  parent: AnyTable;
  childColumn: string;
  parentColumn: string;
}>;

type WritePolicyDefinition<Principal> =
  | Readonly<{ kind: "allow"; table: AnyTable }>
  | Readonly<{ kind: "deny"; table: AnyTable }>
  | WherePolicy<Principal>
  | ThroughPolicy;

export type WritePolicy<Principal> = Readonly<{
  [writePolicyDefinition]: Readonly<{
    principalSchema: ZodType;
    policy: WritePolicyDefinition<Principal>;
  }>;
}>;

export interface WritePolicyBuilder<Principal> {
  where<TableValue extends AnyTable>(
    table: TableValue,
    authorize: (request: {
      change: WriteChange<InferRow<TableValue>>;
      principal: Principal;
      db: TransactionReader;
    }) => boolean | PromiseLike<boolean>,
  ): WritePolicy<Principal>;

  through<ChildTable extends AnyTable, ParentTable extends AnyTable, Data>(
    table: ChildTable,
    parent: ParentTable,
    relationship: Readonly<{
      from: Column<Data, boolean, boolean, boolean>;
      to: Column<Data, boolean, boolean, boolean>;
    }>,
  ): WritePolicy<Principal>;

  allowAll<TableValue extends AnyTable>(
    table: TableValue,
  ): WritePolicy<Principal>;

  denyAll<TableValue extends AnyTable>(
    table: TableValue,
  ): WritePolicy<Principal>;
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

function policy<Principal>(
  principalSchema: ZodType,
  definition: WritePolicyDefinition<Principal>,
): WritePolicy<Principal> {
  return Object.freeze({
    [writePolicyDefinition]: Object.freeze({
      principalSchema,
      policy: Object.freeze(definition),
    }),
  });
}

export function writePolicy<PrincipalSchema extends ZodType>(
  principalSchema: PrincipalSchema,
): WritePolicyBuilder<ZodOutput<PrincipalSchema>> {
  type Principal = ZodOutput<PrincipalSchema>;
  return Object.freeze({
    where<TableValue extends AnyTable>(
      table: TableValue,
      authorize: (request: {
        change: WriteChange<InferRow<TableValue>>;
        principal: Principal;
        db: TransactionReader;
      }) => boolean | PromiseLike<boolean>,
    ) {
      return policy(principalSchema, {
        kind: "where",
        table,
        authorize: authorize as WherePolicy<Principal>["authorize"],
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
          "Write-policy relationship starts outside its table",
        );
      }
      if (target.tableName !== getTableDefinition(parent).name) {
        throw new TypeError(
          "Write-policy relationship ends outside its parent",
        );
      }
      if (child.dataType !== target.dataType) {
        throw new TypeError(
          "Write-policy relationship columns must have the same data type",
        );
      }
      const primaryKeys = Object.values(getTableDefinition(parent).columns)
        .filter((column) => getColumnDefinition(column).primaryKey)
        .map((column) => getColumnDefinition(column).name);
      if (primaryKeys.length !== 1 || primaryKeys[0] !== target.name) {
        throw new TypeError(
          "Write-policy relationships must target a single-column primary key",
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

function rowForRelationship(
  change: WriteChange<Readonly<Record<string, unknown>>>,
  side: "before" | "after",
): Readonly<Record<string, unknown>> | undefined {
  if (side === "before") {
    return change.kind === "insert" ? undefined : change.before;
  }
  return change.kind === "delete" ? undefined : change.after;
}

export interface WritePolicyEnforcer<Principal> {
  authorize(
    table: AnyTable,
    change: WriteChange<Readonly<Record<string, unknown>>>,
    principal: Principal,
    db: TransactionReader,
  ): Promise<void>;
}

export function createWritePolicyEnforcer<Principal>(
  schema: AnySchema,
  principalSchema: ZodType,
  policies: readonly WritePolicy<Principal>[],
): WritePolicyEnforcer<Principal> {
  const schemaTables = new Map(
    Object.values(getSchemaDefinition(schema).tables).map((table) => [
      getTableDefinition(table).name,
      table,
    ]),
  );
  const catalog = new Map<string, WritePolicyDefinition<Principal>>();

  for (const value of policies) {
    const wrapped = value[writePolicyDefinition];
    if (wrapped.principalSchema !== principalSchema) {
      throw new TypeError(
        "Write policies must use the command factory's principal schema",
      );
    }
    const definition = wrapped.policy;
    const name = getTableDefinition(definition.table).name;
    if (schemaTables.get(name) !== definition.table) {
      throw new TypeError(`Write policy references an unknown table: ${name}`);
    }
    if (catalog.has(name)) {
      throw new TypeError(`Duplicate write policy for table: ${name}`);
    }
    catalog.set(name, definition);
  }

  for (const name of schemaTables.keys()) {
    if (!catalog.has(name)) {
      throw new TypeError(`Missing write policy for table: ${name}`);
    }
  }

  const authorize = async (
    table: AnyTable,
    change: WriteChange<Readonly<Record<string, unknown>>>,
    principal: Principal,
    db: TransactionReader,
    path: ReadonlySet<string>,
  ): Promise<boolean> => {
    const name = getTableDefinition(table).name;
    if (path.has(name)) {
      throw new TypeError(`Cyclic write-policy relationship at table: ${name}`);
    }
    const definition = catalog.get(name);
    if (definition === undefined) return false;
    if (definition.kind === "allow") return true;
    if (definition.kind === "deny") return false;
    if (definition.kind === "where") {
      return (await definition.authorize({ change, principal, db })) === true;
    }

    const nextPath = new Set(path).add(name);
    const authorizeSide = async (side: "before" | "after") => {
      const row = rowForRelationship(change, side);
      if (row === undefined) return true;
      const value = row[definition.childColumn];
      if (value === null || value === undefined) return false;
      const parent = await db.get(definition.parent, [value]);
      if (parent === undefined) return false;
      return authorize(
        definition.parent,
        { kind: "update", before: parent, after: parent },
        principal,
        db,
        nextPath,
      );
    };

    return change.kind === "insert"
      ? authorizeSide("after")
      : change.kind === "delete"
        ? authorizeSide("before")
        : (await authorizeSide("before")) && (await authorizeSide("after"));
  };

  return Object.freeze({
    async authorize(
      table: AnyTable,
      change: WriteChange<Readonly<Record<string, unknown>>>,
      principal: Principal,
      db: TransactionReader,
    ) {
      if (!(await authorize(table, change, principal, db, new Set()))) {
        throw new AuthorizationError(
          `Write policy denied ${change.kind} on ${getTableDefinition(table).name}`,
        );
      }
    },
  });
}

export function getWritePolicyPrincipalSchema<Principal>(
  value: WritePolicy<Principal>,
): ZodType {
  return value[writePolicyDefinition].principalSchema;
}
