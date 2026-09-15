import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { hydb, id, text, timestamp } from "../src/index.js";
import {
  applySchemaChanges,
  checkMigrationChain,
  defineMigration,
  describeSchema,
  diffSchemaDescriptions,
  formatMigrationSource,
  reverseSchemaChanges,
  schemaFingerprint,
} from "../src/node/index.js";

const execFileAsync = promisify(execFile);

const v1Rows = hydb.table("mdiff_rows", {
  id: id().primaryKey(),
  title: text().notNull(),
  archivedAt: timestamp(),
});
const v1Tags = hydb.table("mdiff_tags", {
  id: id().primaryKey(),
  label: text().notNull(),
});
const v1Schema = hydb.schema({ rows: v1Rows, tags: v1Tags });

const v2Rows = hydb.table("mdiff_rows", {
  id: id().primaryKey(),
  title: text().notNull(),
  note: text(),
});
const v2Schema = hydb.schema({ rows: v2Rows });

const v1Description = describeSchema(v1Schema);
const v2Description = describeSchema(v2Schema);
const diff = diffSchemaDescriptions(v1Description, v2Description);

test("diffSchemaDescriptions produces ops that apply and reverse exactly", () => {
  const applied = applySchemaChanges(v1Description, diff);
  assert.deepEqual(applied, v2Description);
  const reversed = reverseSchemaChanges(v2Description, diff);
  assert.deepEqual(reversed, v1Description);
  assert.deepEqual(
    diff.map((op) =>
      op.type === "addTable" || op.type === "dropTable"
        ? `${op.type}:${op.description.name}`
        : `${op.type}:${op.table}.${op.column.name}`,
    ),
    [
      "dropColumn:mdiff_rows.archivedAt",
      "addColumn:mdiff_rows.note",
      "dropTable:mdiff_tags",
    ],
  );
});

test("checkMigrationChain accepts a chain covering the full diff", () => {
  const migrations = [defineMigration({ id: "0001-mdiff", steps: diff })];
  const check = checkMigrationChain(v2Schema, migrations, v1Schema);
  assert.equal(check.error, undefined);
  assert.deepEqual(check.issues, []);
  assert.equal(check.ok, true);
  assert.equal(check.baseFingerprint, schemaFingerprint(v1Description));
  assert.equal(check.targetFingerprint, schemaFingerprint(v2Description));
});

test("checkMigrationChain validates internal consistency without a base", () => {
  const migrations = [defineMigration({ id: "0001-mdiff", steps: diff })];
  const check = checkMigrationChain(v2Schema, migrations);
  assert.equal(check.ok, true);
  assert.equal(check.error, undefined);
});

test("checkMigrationChain rejects a chain that misses the supplied base", () => {
  const check = checkMigrationChain(
    v2Schema,
    [defineMigration({ id: "0001-mdiff", steps: diff })],
    // The chain derives from v1, not from v2 itself.
    v2Schema,
  );
  assert.equal(check.ok, false);
  assert.match(
    check.error ?? "",
    /does not start from the supplied base schema/,
  );
});

test("checkMigrationChain reports missing schema operations", () => {
  const migrations = [
    defineMigration({
      id: "0001-partial",
      // Only drops the column; the note addition and tags removal are missing.
      steps: [diff[0]!],
    }),
  ];
  const check = checkMigrationChain(v2Schema, migrations, v1Schema);
  assert.equal(check.ok, false);
  assert.equal(check.issues.length, 1);
  assert.deepEqual(
    check.issues[0]!.missing.map((op) => op.type),
    ["addColumn", "dropTable"],
  );
  assert.deepEqual(check.issues[0]!.extra, []);
});

const tempColumn = {
  name: "mdiffTemp",
  dataType: "text",
  notNull: false,
  primaryKey: false,
};

test("checkMigrationChain treats data-paired ops as extra but not fatal", () => {
  let dataRan = false;
  const migrations = [
    defineMigration({
      id: "0001-pair",
      steps: [
        // A temporary column added and removed within the same migration
        // (around a data step), so the structural diff never sees it.
        {
          type: "addColumn",
          table: "mdiff_rows",
          column: tempColumn,
        },
        {
          kind: "data",
          run: async () => {
            dataRan = true;
          },
        },
        {
          type: "dropColumn",
          table: "mdiff_rows",
          column: tempColumn,
        },
        diff[0]!, // dropColumn archivedAt
        diff[1]!, // addColumn note
        diff[2]!, // dropTable tags
      ],
    }),
  ];
  const check = checkMigrationChain(v2Schema, migrations, v1Schema);
  assert.equal(dataRan, false);
  assert.equal(check.issues[0]!.missing.length, 0);
  assert.equal(check.ok, true);
  assert.deepEqual(
    check.issues[0]!.extra.map((op) => op.type),
    ["addColumn", "dropColumn"],
  );
});

test("checkMigrationChain surfaces an invalid chain as an error", () => {
  const check = checkMigrationChain(v2Schema, [
    defineMigration({
      id: "0001-bogus",
      steps: [
        {
          type: "dropColumn",
          table: "mdiff_rows",
          // `note` exists in the target schema, so reversing this op fails.
          column: {
            name: "note",
            dataType: "integer",
            notNull: false,
            primaryKey: false,
          },
        },
      ],
    }),
  ]);
  assert.equal(check.ok, false);
  assert.match(check.error ?? "", /Column already exists/);
});

test("formatMigrationSource renders runnable migration source", () => {
  const source = formatMigrationSource("0002-mdiff", diff);
  assert.match(
    source,
    /import \{ ddl, defineMigration \} from "@hyos\/hydb\/node"/,
  );
  assert.match(source, /id: "0002-mdiff"/);
  assert.match(source, /ddl\.dropColumn\("mdiff_rows", "archivedAt"/);
  assert.match(source, /ddl\.addColumn\("mdiff_rows", "note"/);
  assert.match(source, /ddl\.dropTable\(\{/, "renders table descriptions");
});

test("migration CLI checks chains and generates migration files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-cli-"));
  // Resolve the package root from either src/test or dist/test.
  let root = import.meta.dirname;
  while (!existsSync(join(root, "package.json"))) root = join(root, "..");
  const cli = join(root, "scripts", "migration-cli.mjs");
  const distIndex = join(root, "dist", "src", "index.js");
  const distNodeIndex = join(root, "dist", "src", "node", "index.js");
  const schemaModule = join(directory, "schemas.mjs");
  const migrationsModule = join(directory, "migrations.mjs");
  await writeFile(
    schemaModule,
    `import { hydb, id, text, timestamp } from ${JSON.stringify(distIndex)};
export const v1 = hydb.schema({
  mdiff_rows: hydb.table("mdiff_rows", {
    id: id().primaryKey(),
    title: text().notNull(),
    archivedAt: timestamp(),
  }),
  mdiff_tags: hydb.table("mdiff_tags", {
    id: id().primaryKey(),
    label: text().notNull(),
  }),
});
export const v2 = hydb.schema({
  mdiff_rows: hydb.table("mdiff_rows", {
    id: id().primaryKey(),
    title: text().notNull(),
    note: text(),
  }),
});
`,
  );
  await writeFile(
    migrationsModule,
    `import { defineMigration, describeSchema, diffSchemaDescriptions } from ${JSON.stringify(distNodeIndex)};
import { v1, v2 } from ${JSON.stringify(schemaModule)};
export default [
  defineMigration({
    id: "0001-mdiff",
    steps: diffSchemaDescriptions(describeSchema(v1), describeSchema(v2)),
  }),
];
`,
  );
  try {
    // check: declared chain covers the diff from the supplied base.
    const check = await execFileAsync(process.execPath, [
      cli,
      "check",
      "--schema",
      `${schemaModule}#v2`,
      "--base",
      `${schemaModule}#v1`,
      "--migrations",
      migrationsModule,
    ]);
    assert.match(check.stdout, /migration chain covers the schema change/);

    // check: a schema that differs from the chain target fails with exit 1.
    await assert.rejects(
      execFileAsync(process.execPath, [
        cli,
        "check",
        "--schema",
        `${schemaModule}#v1`,
        "--migrations",
        migrationsModule,
      ]),
      (error) => (error as { code?: number }).code === 1,
    );

    // generate: writes the next migration from the v1 -> v2 diff.
    const out = join(directory, "0002-generated.ts");
    const generated = await execFileAsync(process.execPath, [
      cli,
      "generate",
      "--id",
      "0002-generated",
      "--from",
      `${schemaModule}#v1`,
      "--to",
      `${schemaModule}#v2`,
      "--out",
      out,
    ]);
    assert.match(generated.stdout, /wrote .*0002-generated\.ts/);
    const source = await readFile(out, "utf8");
    assert.match(source, /ddl\.dropTable\(/);
    assert.match(source, /ddl\.dropColumn\("mdiff_rows", "archivedAt"/);

    // generate refuses to overwrite without --force.
    await assert.rejects(
      execFileAsync(process.execPath, [
        cli,
        "generate",
        "--id",
        "0002-generated",
        "--from",
        `${schemaModule}#v1`,
        "--to",
        `${schemaModule}#v2`,
        "--out",
        out,
      ]),
      (error) => (error as { code?: number }).code === 1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
