import { createHash } from "node:crypto";

import {
  getColumnBuilderDefinition,
  getColumnDefinition,
  getIndexDefinition,
  getSchemaDefinition,
  getTableDefinition,
  type AnyColumnBuilder,
  type AnySchema,
  type AnyTable,
} from "../schema.js";
import type { StorageKey } from "../storage.js";

/**
 * Plain, JSON-serializable schema description. The serialization order here
 * must stay identical to the persisted schema fingerprint format: the
 * fingerprint of a description is `sha256(JSON.stringify(tables))` with tables
 * sorted by name and columns in declaration order.
 */
export type ColumnDescription = Readonly<{
  name: string;
  dataType: string;
  notNull: boolean;
  primaryKey: boolean;
}>;

export type IndexDescription = Readonly<{
  name: string;
  unique: boolean;
  columns: readonly string[];
}>;

export type TableDescription = Readonly<{
  name: string;
  columns: readonly ColumnDescription[];
  indexes: readonly IndexDescription[];
}>;

export type SchemaDescription = readonly TableDescription[];

/** Serializes to the persisted `manifest.schema` fingerprint format. */
export function schemaFingerprint(description: SchemaDescription): string {
  return createHash("sha256").update(JSON.stringify(description)).digest("hex");
}

/** Extracts the fingerprint-compatible description of a schema. */
export function describeSchema(schema: AnySchema): SchemaDescription {
  return Object.values(getSchemaDefinition(schema).tables)
    .map((table) => {
      const definition = getTableDefinition(table);
      return {
        name: definition.name,
        columns: Object.entries(definition.columns).map(([name, column]) => {
          const value = getColumnDefinition(column);
          return {
            name,
            dataType: value.dataType,
            notNull: value.notNull,
            primaryKey: value.primaryKey,
          };
        }),
        indexes: definition.indexes.map((value) => {
          const index = getIndexDefinition(value);
          return {
            name: index.name,
            unique: index.unique,
            columns: index.columns.map(
              (column) => getColumnDefinition(column).name,
            ),
          };
        }),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * A column spec: either a column builder (name supplied by the operation) or
 * an already-resolved description, e.g. one captured by the migration
 * generator for a column that no longer exists in code.
 */
export type ColumnSpec = AnyColumnBuilder | ColumnDescription;

function isColumnBuilder(spec: ColumnSpec): spec is AnyColumnBuilder {
  return typeof (spec as { notNull?: unknown }).notNull === "function";
}

function resolveColumn(spec: ColumnSpec, name: string): ColumnDescription {
  if (isColumnBuilder(spec)) {
    const definition = getColumnBuilderDefinition(spec);
    return {
      name,
      dataType: definition.dataType,
      notNull: definition.notNull,
      primaryKey: definition.primaryKey,
    };
  }
  const description = spec as ColumnDescription;
  if (description.name !== name) {
    throw new TypeError(
      `Column description name ${description.name} does not match ${name}`,
    );
  }
  return description;
}

function tableDescription(table: AnyTable): TableDescription {
  const definition = getTableDefinition(table);
  return {
    name: definition.name,
    columns: Object.entries(definition.columns).map(([name, column]) => {
      const value = getColumnDefinition(column);
      return {
        name,
        dataType: value.dataType,
        notNull: value.notNull,
        primaryKey: value.primaryKey,
      };
    }),
    indexes: definition.indexes.map((value) => {
      const index = getIndexDefinition(value);
      return {
        name: index.name,
        unique: index.unique,
        columns: index.columns.map(
          (column) => getColumnDefinition(column).name,
        ),
      };
    }),
  };
}

/**
 * Declarative schema operations. Each op carries enough information to be
 * inverted, so a chain of migrations can be walked backwards from the current
 * schema to reconstruct every historical fingerprint.
 */
export type SchemaOp =
  | Readonly<{
      type: "addTable";
      table: AnyTable | TableDescription;
      description: TableDescription;
    }>
  | Readonly<{
      type: "dropTable";
      table: AnyTable | TableDescription;
      description: TableDescription;
    }>
  | Readonly<{
      type: "addColumn";
      table: string;
      column: ColumnDescription;
    }>
  | Readonly<{
      type: "dropColumn";
      table: string;
      column: ColumnDescription;
    }>
  | Readonly<{
      type: "changeColumn";
      table: string;
      column: ColumnDescription;
      previous: ColumnDescription;
    }>;

/**
 * Accepts either a table builder or an already-resolved description, e.g. one
 * captured by the migration tooling for a table that no longer exists in code.
 */
function asTableDescription(
  table: AnyTable | TableDescription,
): TableDescription {
  const candidate = table as TableDescription;
  if (
    typeof candidate.name === "string" &&
    Array.isArray(candidate.columns) &&
    Array.isArray(candidate.indexes)
  ) {
    return candidate;
  }
  return tableDescription(table as AnyTable);
}

/** Adds a table that does not exist yet. */
export function addTable(table: AnyTable | TableDescription): SchemaOp {
  const description = asTableDescription(table);
  if (!description.columns.some((column) => column.primaryKey)) {
    throw new TypeError(`Added table has no primary key: ${description.name}`);
  }
  return Object.freeze({ type: "addTable", table, description });
}

/** Removes a table. The definition is required so the op can be inverted. */
export function dropTable(table: AnyTable | TableDescription): SchemaOp {
  return Object.freeze({
    type: "dropTable",
    table,
    description: asTableDescription(table),
  });
}

/**
 * Adds a column. It must be nullable, not a primary key, and not indexed:
 * existing rows receive null (or the column's declared default) without any
 * data transformation.
 */
export function addColumn(
  table: string,
  name: string,
  column: ColumnSpec,
): SchemaOp {
  const description = resolveColumn(column, name);
  if (description.notNull || description.primaryKey) {
    throw new TypeError(
      `addColumn requires a nullable, non-primary-key column: ${table}.${name}`,
    );
  }
  return Object.freeze({ type: "addColumn", table, column: description });
}

/**
 * Removes a column. The previous column spec is required so the op can be
 * inverted; the migration generator captures it automatically.
 */
export function dropColumn(
  table: string,
  name: string,
  previous: ColumnSpec,
): SchemaOp {
  const description = resolveColumn(previous, name);
  return Object.freeze({ type: "dropColumn", table, column: description });
}

/**
 * Changes a column's type or nullability. The previous spec is required so
 * the op can be inverted; the primary key status cannot change. Any data
 * conversion belongs in an interleaved data step.
 */
export function changeColumn(
  table: string,
  name: string,
  previous: ColumnSpec,
  column: ColumnSpec,
): SchemaOp {
  const description = resolveColumn(column, name);
  const old = resolveColumn(previous, name);
  if (description.primaryKey !== old.primaryKey) {
    throw new TypeError(
      `changeColumn cannot change primary key status: ${table}.${name}`,
    );
  }
  return Object.freeze({
    type: "changeColumn",
    table,
    column: description,
    previous: old,
  });
}

/** Builder namespace for schema operations. */
export const ddl = {
  addTable,
  dropTable,
  addColumn,
  dropColumn,
  changeColumn,
};

function workingTables(
  description: SchemaDescription,
): Map<string, TableDescription> {
  const tables = new Map<string, TableDescription>();
  for (const table of description) {
    if (tables.has(table.name)) {
      throw new TypeError(`Duplicate table in description: ${table.name}`);
    }
    tables.set(table.name, table);
  }
  return tables;
}

function serializeTables(
  tables: Map<string, TableDescription>,
): SchemaDescription {
  return [...tables.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function columnNames(table: TableDescription): Set<string> {
  return new Set(table.columns.map((column) => column.name));
}

function assertColumn(
  table: TableDescription,
  name: string,
): ColumnDescription {
  const column = table.columns.find((column) => column.name === name);
  if (column === undefined) {
    throw new TypeError(`Unknown column: ${table.name}.${name}`);
  }
  return column;
}

function assertIndexFree(
  table: TableDescription,
  name: string,
  action: string,
): void {
  for (const index of table.indexes) {
    if (index.columns.includes(name)) {
      throw new TypeError(
        `Cannot ${action} indexed column: ${table.name}.${name}`,
      );
    }
  }
}

/**
 * Applies schema operations forward, returning a new description. Operations
 * are validated structurally: unknown tables or columns, duplicate columns,
 * primary-key violations, and indexed-column removals all throw before any
 * fingerprint is derived.
 */
export function applySchemaChanges(
  description: SchemaDescription,
  ops: readonly SchemaOp[],
): SchemaDescription {
  const tables = workingTables(description);
  for (const op of ops) {
    if (op.type === "addTable") {
      if (tables.has(op.description.name)) {
        throw new TypeError(`Table already exists: ${op.description.name}`);
      }
      if (!op.description.columns.some((column) => column.primaryKey)) {
        throw new TypeError(
          `Added table has no primary key: ${op.description.name}`,
        );
      }
      tables.set(op.description.name, op.description);
      continue;
    }
    if (op.type === "dropTable") {
      if (!tables.delete(op.description.name)) {
        throw new TypeError(`Unknown table: ${op.description.name}`);
      }
      continue;
    }
    const table = tables.get(op.table);
    if (table === undefined) {
      throw new TypeError(`Unknown table: ${op.table}`);
    }
    if (op.type === "addColumn") {
      const names = columnNames(table);
      if (names.has(op.column.name)) {
        throw new TypeError(
          `Column already exists: ${op.table}.${op.column.name}`,
        );
      }
      assertIndexFree(table, op.column.name, "add");
      tables.set(op.table, {
        ...table,
        columns: [...table.columns, op.column],
      });
      continue;
    }
    if (op.type === "dropColumn") {
      const existing = assertColumn(table, op.column.name);
      if (
        existing.dataType !== op.column.dataType ||
        existing.notNull !== op.column.notNull ||
        existing.primaryKey !== op.column.primaryKey
      ) {
        throw new TypeError(
          `Previous column does not match: ${op.table}.${op.column.name}`,
        );
      }
      if (existing.primaryKey) {
        throw new TypeError(
          `Cannot drop primary key column: ${op.table}.${op.column.name}`,
        );
      }
      assertIndexFree(table, op.column.name, "drop");
      tables.set(op.table, {
        ...table,
        columns: table.columns.filter(
          (column) => column.name !== op.column.name,
        ),
      });
      continue;
    }
    // changeColumn
    const existing = assertColumn(table, op.column.name);
    if (
      existing.dataType !== op.previous.dataType ||
      existing.notNull !== op.previous.notNull ||
      existing.primaryKey !== op.previous.primaryKey
    ) {
      throw new TypeError(
        `Previous column does not match: ${op.table}.${op.column.name}`,
      );
    }
    tables.set(op.table, {
      ...table,
      columns: table.columns.map((column) =>
        column.name === op.column.name ? op.column : column,
      ),
    });
  }
  return serializeTables(tables);
}

/**
 * Applies the inverse of each operation in reverse order, reconstructing the
 * description that preceded the operations. This is how a chain of forward
 * migrations is walked backwards from the current schema to derive every
 * historical fingerprint.
 */
export function reverseSchemaChanges(
  description: SchemaDescription,
  ops: readonly SchemaOp[],
): SchemaDescription {
  const tables = workingTables(description);
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index]!;
    if (op.type === "addTable") {
      if (!tables.delete(op.description.name)) {
        throw new TypeError(`Unknown table: ${op.description.name}`);
      }
      continue;
    }
    if (op.type === "dropTable") {
      if (tables.has(op.description.name)) {
        throw new TypeError(`Table already exists: ${op.description.name}`);
      }
      tables.set(op.description.name, op.description);
      continue;
    }
    const table = tables.get(op.table);
    if (table === undefined) {
      throw new TypeError(`Unknown table: ${op.table}`);
    }
    if (op.type === "addColumn") {
      const existing = assertColumn(table, op.column.name);
      if (
        existing.dataType !== op.column.dataType ||
        existing.notNull !== op.column.notNull ||
        existing.primaryKey !== op.column.primaryKey
      ) {
        throw new TypeError(
          `Column does not match added column: ${op.table}.${op.column.name}`,
        );
      }
      tables.set(op.table, {
        ...table,
        columns: table.columns.filter(
          (column) => column.name !== op.column.name,
        ),
      });
      continue;
    }
    if (op.type === "dropColumn") {
      if (columnNames(table).has(op.column.name)) {
        throw new TypeError(
          `Column already exists: ${op.table}.${op.column.name}`,
        );
      }
      tables.set(op.table, {
        ...table,
        columns: [...table.columns, op.column],
      });
      continue;
    }
    // changeColumn: restore the previous description.
    const existing = assertColumn(table, op.column.name);
    if (
      existing.dataType !== op.column.dataType ||
      existing.notNull !== op.column.notNull ||
      existing.primaryKey !== op.column.primaryKey
    ) {
      throw new TypeError(
        `Column does not match changed column: ${op.table}.${op.column.name}`,
      );
    }
    tables.set(op.table, {
      ...table,
      columns: table.columns.map((column) =>
        column.name === op.column.name ? op.previous : column,
      ),
    });
  }
  return serializeTables(tables);
}

/**
 * Database surface available to data steps. Reads and writes run through the
 * normal commit pipeline, so every data step is an ordinary, durable commit.
 */
export type MigrationDatabase = {
  scan(table: string): AsyncIterable<Readonly<Record<string, unknown>>>;
  insert(table: string, row: Readonly<Record<string, unknown>>): Promise<void>;
  update(
    table: string,
    key: StorageKey,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  delete(table: string, key: StorageKey): Promise<void>;
};

export type MigrationDataStep = (database: MigrationDatabase) => Promise<void>;

/** One migration step: either a schema operation or a data transformation. */
export type MigrationStep =
  SchemaOp | Readonly<{ kind: "data"; run: MigrationDataStep }>;

/** Wraps a data transformation as one migration step (one commit). */
export function data(run: MigrationDataStep): MigrationStep {
  return Object.freeze({ kind: "data", run });
}

function isDataStep(
  step: MigrationStep,
): step is Readonly<{ kind: "data"; run: MigrationDataStep }> {
  return (step as { kind?: unknown }).kind === "data";
}

function asSchemaOps(steps: readonly MigrationStep[]): SchemaOp[] {
  return steps.filter((step) => !isDataStep(step)) as SchemaOp[];
}

export type Migration = Readonly<{
  id: string;
  steps: readonly MigrationStep[];
}>;

/**
 * Declares one migration: an ordered list of schema operations interleaved
 * with data steps. Each step is applied as its own commit; data steps run
 * against the schema as of the preceding schema operation.
 */
export function defineMigration(spec: {
  id: string;
  steps: readonly MigrationStep[];
}): Migration {
  if (typeof spec.id !== "string" || spec.id.length === 0) {
    throw new TypeError("Migration id must be a non-empty string");
  }
  const steps = [...spec.steps];
  if (steps.length === 0) {
    throw new TypeError(`Migration ${spec.id} has no steps`);
  }
  for (const step of steps) {
    if (isDataStep(step)) {
      if (typeof step.run !== "function") {
        throw new TypeError(`Migration ${spec.id} has an invalid data step`);
      }
    } else if (!step || typeof (step as { type?: unknown }).type !== "string") {
      throw new TypeError(`Migration ${spec.id} has an invalid schema step`);
    }
  }
  // Structural consistency between schema ops is validated when the
  // migration chain is replayed against the current schema at storage open;
  // interleaved data steps may legitimately add and later drop a column.
  return Object.freeze({ id: spec.id, steps: Object.freeze(steps) });
}

export type MigrationFingerprint = Readonly<{
  /** Migration whose target this description is, or null for the base
   * schema the first migration upgrades from. */
  migrationId: string | null;
  /** Fingerprint of the description after that migration's schema ops. */
  fingerprint: string;
  description: SchemaDescription;
}>;

/**
 * Walks an ordered migration list backwards from the current schema,
 * returning the chain of descriptions and fingerprints: the base schema the
 * first migration upgrades from, followed by each migration's target. Every
 * stored head fingerprint must be one of these chain nodes (or the base).
 */
export function deriveMigrationFingerprints(
  schema: AnySchema,
  migrations: readonly Migration[],
): MigrationFingerprint[] {
  const nodes: MigrationFingerprint[] = [];
  let description = describeSchema(schema);
  for (let index = migrations.length - 1; index >= 0; index -= 1) {
    const migration = migrations[index]!;
    nodes.push({
      migrationId: migration.id,
      fingerprint: schemaFingerprint(description),
      description,
    });
    description = reverseSchemaChanges(
      description,
      asSchemaOps(migration.steps),
    );
  }
  nodes.push({
    migrationId: null,
    fingerprint: schemaFingerprint(description),
    description,
  });
  return nodes.reverse();
}

/** One executable migration step with its before/after schema fingerprints. */
export type PlannedStep =
  | Readonly<{
      kind: "schema";
      op: SchemaOp;
      from: string;
      to: string;
    }>
  | Readonly<{
      kind: "data";
      run: MigrationDataStep;
      /** Schema fingerprint the data step runs against (and keeps). */
      fingerprint: string;
    }>;

export type MigrationPlan = Readonly<{
  /** Fingerprint of the schema the first step upgrades from. */
  base: string;
  /** Fingerprint of the schema after every step has been applied. */
  final: string;
  steps: readonly PlannedStep[];
}>;

/**
 * Flattens an ordered migration list into executable steps, computing the
 * schema fingerprint after every schema operation. The result drives the
 * per-step commit loop in node storage: each step becomes exactly one commit
 * per branch, and the recorded fingerprints let a crashed run resume at the
 * exact step that never committed.
 */
export function buildMigrationPlan(
  schema: AnySchema,
  migrations: readonly Migration[],
): MigrationPlan {
  const nodes = deriveMigrationFingerprints(schema, migrations);
  let description = nodes[0]!.description;
  const steps: PlannedStep[] = [];
  for (const migration of migrations) {
    for (const step of migration.steps) {
      if (isDataStep(step)) {
        steps.push({
          kind: "data",
          run: step.run,
          fingerprint: schemaFingerprint(description),
        });
        continue;
      }
      const next = applySchemaChanges(description, [step]);
      steps.push({
        kind: "schema",
        op: step,
        from: schemaFingerprint(description),
        to: schemaFingerprint(next),
      });
      description = next;
    }
  }
  return Object.freeze({
    base: nodes[0]!.fingerprint,
    final: nodes[nodes.length - 1]!.fingerprint,
    steps: Object.freeze(steps),
  });
}

/**
 * Stable identity of a schema operation for diffing declared migrations
 * against the structural difference between two schema descriptions.
 */
function schemaOpKey(op: SchemaOp): string {
  if (op.type === "addTable" || op.type === "dropTable") {
    return `${op.type}:${op.description.name}`;
  }
  return `${op.type}:${op.table}:${op.column.name}`;
}

/**
 * Computes the schema operations that convert one description into another:
 * column drops, changes, and additions per shared table, then dropped tables,
 * then added tables. The result applied forward via `applySchemaChanges`
 * yields exactly the target description. Diffs that would require an
 * incompatible operation (for example adding a required column) throw from
 * the op constructors; such changes need an interleaved data step instead.
 */
export function diffSchemaDescriptions(
  from: SchemaDescription,
  to: SchemaDescription,
): SchemaOp[] {
  const toTables = new Map(to.map((table) => [table.name, table]));
  const fromNames = new Set(from.map((table) => table.name));
  const ops: SchemaOp[] = [];
  for (const before of from) {
    const after = toTables.get(before.name);
    if (after === undefined) {
      ops.push(dropTable(before));
      continue;
    }
    const beforeColumns = new Map(
      before.columns.map((column) => [column.name, column]),
    );
    const afterColumns = new Map(
      after.columns.map((column) => [column.name, column]),
    );
    for (const [name, previous] of beforeColumns) {
      const next = afterColumns.get(name);
      if (next === undefined) {
        ops.push(dropColumn(before.name, name, previous));
      } else if (
        next.dataType !== previous.dataType ||
        next.notNull !== previous.notNull
      ) {
        ops.push(changeColumn(before.name, name, previous, next));
      }
    }
    for (const [name, column] of afterColumns) {
      if (!beforeColumns.has(name)) {
        ops.push(addColumn(before.name, name, column));
      }
    }
  }
  for (const after of to) {
    if (!fromNames.has(after.name)) ops.push(addTable(after));
  }
  return ops;
}

export type MigrationChainIssue = Readonly<{
  migrationId: string;
  /** Schema differences the migration does not declare. */
  missing: readonly SchemaOp[];
  /**
   * Declared schema ops beyond the structural difference. These are expected
   * when a data step pairs an addition with a later removal; empty `missing`
   * with non-empty `extra` is not an error.
   */
  extra: readonly SchemaOp[];
}>;

export type MigrationChainCheck = Readonly<{
  /** True when every schema difference is covered by a declared op. */
  ok: boolean;
  baseFingerprint: string;
  baseDescription: SchemaDescription;
  targetFingerprint: string;
  issues: readonly MigrationChainIssue[];
  /** Set when the migration chain itself is invalid. */
  error?: string;
}>;

/**
 * Verifies that an ordered migration list covers the schema change it claims
 * to. Without a base schema the check validates only that the chain itself is
 * internally consistent. When `base` (a schema or a captured description) is
 * given, the chain's derived base must equal it, and every structural
 * difference between the base and the current schema must be declared: any
 * undeclared difference is reported as missing, and any declared op that does
 * not correspond to a difference is reported as extra (legitimate only when
 * paired with a data step).
 */
export function checkMigrationChain(
  schema: AnySchema,
  migrations: readonly Migration[],
  base?: AnySchema | SchemaDescription,
): MigrationChainCheck {
  let nodes: MigrationFingerprint[];
  try {
    nodes = deriveMigrationFingerprints(schema, migrations);
  } catch (error) {
    return {
      ok: false,
      baseFingerprint: "",
      baseDescription: [],
      targetFingerprint: "",
      issues: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const targetDescription = nodes[nodes.length - 1]!.description;
  const targetFingerprint = nodes[nodes.length - 1]!.fingerprint;
  if (base === undefined) {
    return {
      ok: true,
      baseFingerprint: nodes[0]!.fingerprint,
      baseDescription: nodes[0]!.description,
      targetFingerprint,
      issues: [],
    };
  }
  const baseDescription = Array.isArray(base)
    ? base
    : describeSchema(base as AnySchema);
  const baseFingerprint = schemaFingerprint(baseDescription);
  const declared = migrations.flatMap((migration) =>
    migration.steps.filter((step) => !isDataStep(step)),
  ) as SchemaOp[];
  const expected = diffSchemaDescriptions(baseDescription, targetDescription);
  const declaredKeys = new Set(declared.map(schemaOpKey));
  const expectedKeys = new Set(expected.map(schemaOpKey));
  const missing = expected.filter((op) => !declaredKeys.has(schemaOpKey(op)));
  const extra = declared.filter((op) => !expectedKeys.has(schemaOpKey(op)));
  // Undeclared schema differences are the actionable finding; only when the
  // declared ops cover the whole difference but the chain's derived base
  // still disagrees with the supplied base is the chain itself wrong.
  if (
    missing.length === 0 &&
    schemaFingerprint(nodes[0]!.description) !== baseFingerprint
  ) {
    return {
      ok: false,
      baseFingerprint,
      baseDescription,
      targetFingerprint,
      issues: [],
      error: "the migration chain does not start from the supplied base schema",
    };
  }
  const issues: MigrationChainIssue[] =
    missing.length > 0 || extra.length > 0
      ? [{ migrationId: "", missing, extra }]
      : [];
  return {
    ok: missing.length === 0,
    baseFingerprint,
    baseDescription,
    targetFingerprint,
    issues,
  };
}

function formatColumn(value: ColumnDescription): string {
  return JSON.stringify(value);
}

/**
 * Renders a migration file's source: a `defineMigration` declaration with the
 * given id and schema operations. Data steps cannot be generated; add them by
 * hand where a transformation is required.
 */
export function formatMigrationSource(
  id: string,
  ops: readonly SchemaOp[],
): string {
  const lines: string[] = [
    'import { ddl, defineMigration } from "@hyos/hydb/node";',
    "",
    "// Generated by the hydb migration tooling. Review before applying, and add",
    "// interleaved data steps for any transformation this schema change requires.",
    "export default defineMigration({",
    `  id: ${JSON.stringify(id)},`,
    "  steps: [",
  ];
  for (const op of ops) {
    if (op.type === "addTable" || op.type === "dropTable") {
      lines.push(
        `    ddl.${op.type}(${JSON.stringify(op.description, null, 2).replaceAll("\n", "\n    ")}),`,
      );
    } else if (op.type === "changeColumn") {
      lines.push(
        `    ddl.changeColumn(${JSON.stringify(op.table)}, ${JSON.stringify(op.column.name)}, ${formatColumn(op.previous)}, ${formatColumn(op.column)}),`,
      );
    } else if (op.type === "dropColumn") {
      lines.push(
        `    ddl.dropColumn(${JSON.stringify(op.table)}, ${JSON.stringify(op.column.name)}, ${formatColumn(op.column)}),`,
      );
    } else {
      lines.push(
        `    ddl.addColumn(${JSON.stringify(op.table)}, ${JSON.stringify(op.column.name)}, ${formatColumn(op.column)}),`,
      );
    }
  }
  lines.push("  ],", "});", "");
  return lines.join("\n");
}
