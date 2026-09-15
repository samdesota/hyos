import assert from "node:assert/strict";
import test from "node:test";

import { hydb, id, index, integer, text, timestamp } from "../src/index.js";
import {
  addColumn,
  addTable,
  applySchemaChanges,
  changeColumn,
  data,
  ddl,
  defineMigration,
  describeSchema,
  deriveMigrationFingerprints,
  dropColumn,
  dropTable,
  reverseSchemaChanges,
  schemaFingerprint,
} from "../src/node/index.js";
import { buildMigrationPlan } from "../src/node/migration.js";

const rowsTable = hydb.table("rows", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const tagsTable = hydb.table("tags", {
  name: text().primaryKey(),
});
const indexedTable = hydb.table(
  "indexed",
  {
    id: id().primaryKey(),
    title: text().notNull(),
    order: integer(),
  },
  (columns) => [index("indexed_title").on(columns.title)],
);

const schema = hydb.schema({ rows: rowsTable, indexed: indexedTable });

test("describeSchema produces stable, sorted, hashed descriptions", () => {
  const description = describeSchema(schema);
  assert.deepEqual(
    description.map((table) => table.name),
    ["indexed", "rows"],
  );
  const first = schemaFingerprint(description);
  const second = schemaFingerprint(describeSchema(schema));
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("adding a nullable column changes the fingerprint and round-trips", () => {
  const description = describeSchema(schema);
  const op = ddl.addColumn("rows", "archivedAt", timestamp());
  const next = applySchemaChanges(description, [op]);
  assert.notEqual(schemaFingerprint(next), schemaFingerprint(description));
  assert.deepEqual(
    next.find((table) => table.name === "rows")!.columns.map((c) => c.name),
    ["id", "title", "archivedAt"],
  );
  assert.deepEqual(reverseSchemaChanges(next, [op]), description);
});

test("migration plans use the exact target column order at boundaries", () => {
  const nextRows = hydb.table("rows", {
    id: id().primaryKey(),
    note: text(),
    title: text().notNull(),
  });
  const nextSchema = hydb.schema({ rows: nextRows, indexed: indexedTable });
  const migrations = [
    defineMigration({
      id: "0001-add-note",
      steps: [ddl.addColumn("rows", "note", text())],
    }),
  ];

  const plan = buildMigrationPlan(nextSchema, migrations);
  const step = plan.steps[0];

  assert.ok(step && step.kind === "schema");
  assert.equal(step.from, schemaFingerprint(describeSchema(schema)));
  assert.equal(step.to, schemaFingerprint(describeSchema(nextSchema)));
  assert.equal(plan.final, step.to);
});

test("addColumn rejects non-nullable, primary key, and indexed columns", () => {
  const description = describeSchema(schema);
  assert.throws(
    () => ddl.addColumn("rows", "title", text().notNull()),
    /nullable, non-primary-key/,
  );
  assert.throws(
    () =>
      applySchemaChanges(description, [ddl.addColumn("rows", "id", text())]),
    /already exists/,
  );
  // Indexed table: adding is fine, dropping an indexed column is not.
  assert.throws(
    () =>
      applySchemaChanges(description, [
        ddl.dropColumn("indexed", "title", text().notNull()),
      ]),
    /indexed column/,
  );
});

test("addTable and dropTable round-trip and validate", () => {
  const description = describeSchema(schema);
  const op = ddl.addTable(tagsTable);
  const next = applySchemaChanges(description, [op]);
  assert.deepEqual(
    next.map((table) => table.name),
    ["indexed", "rows", "tags"],
  );
  assert.deepEqual(reverseSchemaChanges(next, [op]), description);
  assert.throws(() => applySchemaChanges(next, [op]), /already exists/);
  assert.throws(
    () => applySchemaChanges(description, [ddl.dropTable(tagsTable)]),
    /Unknown table/,
  );
  const noKey = hydb.table("nokey", { value: integer() });
  assert.throws(
    () => applySchemaChanges(description, [ddl.addTable(noKey)]),
    /no primary key/,
  );
});

test("dropColumn requires the previous spec and validates it", () => {
  const description = describeSchema(schema);
  const op = ddl.dropColumn("rows", "title", text().notNull());
  const next = applySchemaChanges(description, [op]);
  assert.deepEqual(
    next.find((table) => table.name === "rows")!.columns.map((c) => c.name),
    ["id"],
  );
  assert.deepEqual(reverseSchemaChanges(next, [op]), description);
  assert.throws(
    () =>
      applySchemaChanges(description, [
        ddl.dropColumn("rows", "title", integer()),
      ]),
    /Previous column does not match/,
  );
});

test("changeColumn replaces type or nullability but not primary key status", () => {
  const description = describeSchema(schema);
  const op = ddl.changeColumn("indexed", "order", integer(), text());
  const next = applySchemaChanges(description, [op]);
  const column = next
    .find((table) => table.name === "indexed")!
    .columns.find((c) => c.name === "order")!;
  assert.equal(column.dataType, "text");
  assert.deepEqual(reverseSchemaChanges(next, [op]), description);
  assert.throws(
    () => ddl.changeColumn("rows", "id", id().primaryKey(), text()),
    /primary key status/,
  );
  assert.throws(
    () =>
      applySchemaChanges(description, [
        ddl.changeColumn("indexed", "order", text(), text()),
      ]),
    /Previous column does not match/,
  );
});

test("unknown tables and columns throw before any change is applied", () => {
  const description = describeSchema(schema);
  assert.throws(
    () =>
      applySchemaChanges(description, [
        ddl.addColumn("missing", "value", text()),
      ]),
    /Unknown table/,
  );
  assert.throws(
    () =>
      applySchemaChanges(description, [
        ddl.dropColumn("rows", "missing", text()),
      ]),
    /Unknown column/,
  );
});

test("mixed op sequences apply in order and reverse exactly", () => {
  const description = describeSchema(schema);
  const ops = [
    ddl.addTable(tagsTable),
    ddl.addColumn("rows", "archivedAt", timestamp()),
    ddl.changeColumn("indexed", "order", integer(), text()),
  ];
  const next = applySchemaChanges(description, ops);
  assert.deepEqual(
    next.map((table) => table.name),
    ["indexed", "rows", "tags"],
  );
  assert.deepEqual(reverseSchemaChanges(next, ops), description);
});

test("defineMigration validates its spec and preserves step order", () => {
  const migration = defineMigration({
    id: "0001-add-archived-at",
    steps: [
      ddl.addColumn("rows", "archivedAt", timestamp()),
      data(async () => {}),
      ddl.changeColumn("indexed", "order", integer(), text()),
    ],
  });
  assert.equal(migration.id, "0001-add-archived-at");
  assert.deepEqual(
    migration.steps.map((step) => ("kind" in step ? step.kind : step.type)),
    ["addColumn", "data", "changeColumn"],
  );
  assert.throws(
    () => defineMigration({ id: "", steps: [ddl.addTable(tagsTable)] }),
    /non-empty/,
  );
  assert.throws(() => defineMigration({ id: "0002", steps: [] }), /no steps/);
  assert.throws(
    () =>
      defineMigration({
        id: "0003",
        // @ts-expect-error invalid data step
        steps: [data("nope")],
      }),
    /invalid data step/,
  );
});

test("deriveMigrationFingerprints builds the chain with base first", () => {
  const currentSchema = hydb.schema({
    rows: hydb.table("rows", {
      id: id().primaryKey(),
      title: text().notNull(),
      archivedAt: timestamp(),
    }),
    indexed: indexedTable,
    tags: tagsTable,
  });
  const first = defineMigration({
    id: "0001-add-tags",
    steps: [ddl.addTable(tagsTable)],
  });
  const second = defineMigration({
    id: "0002-add-archived-at",
    steps: [ddl.addColumn("rows", "archivedAt", timestamp())],
  });
  const chain = deriveMigrationFingerprints(currentSchema, [first, second]);
  assert.deepEqual(
    chain.map((node) => node.migrationId),
    [null, "0001-add-tags", "0002-add-archived-at"],
  );
  // The newest node matches the current schema's fingerprint.
  assert.equal(
    chain[2]!.fingerprint,
    schemaFingerprint(describeSchema(currentSchema)),
  );
  // The base node matches the original schema's fingerprint.
  assert.equal(
    chain[0]!.fingerprint,
    schemaFingerprint(describeSchema(schema)),
  );
  // Intermediate node matches the original schema plus tags.
  assert.equal(
    chain[1]!.fingerprint,
    schemaFingerprint(
      applySchemaChanges(describeSchema(schema), [addTable(tagsTable)]),
    ),
  );
});

test("deriveMigrationFingerprints rejects inconsistent chains", () => {
  const currentSchema = hydb.schema({
    rows: hydb.table("rows", {
      id: id().primaryKey(),
      title: text().notNull(),
      archivedAt: timestamp(),
    }),
    indexed: indexedTable,
  });
  // Claims title was dropped, but it still exists in the current schema and
  // no later migration re-adds it, so the chain cannot be reversed.
  const bad = defineMigration({
    id: "0001-bad",
    steps: [ddl.dropColumn("rows", "title", text().notNull())],
  });
  assert.throws(
    () => deriveMigrationFingerprints(currentSchema, [bad]),
    /already exists/,
  );
});

test("dropColumn accepts a captured description for removed columns", () => {
  const description = describeSchema(schema);
  const op = dropColumn("rows", "title", {
    name: "title",
    dataType: "text",
    notNull: true,
    primaryKey: false,
  });
  const next = applySchemaChanges(description, [op]);
  assert.deepEqual(
    next.find((table) => table.name === "rows")!.columns.map((c) => c.name),
    ["id"],
  );
  assert.throws(
    () =>
      dropColumn("rows", "other", {
        name: "title",
        dataType: "text",
        notNull: true,
        primaryKey: false,
      }),
    /does not match/,
  );
});
