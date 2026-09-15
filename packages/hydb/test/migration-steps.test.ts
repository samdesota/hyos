import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hydb, id, text, timestamp, storageMutation } from "../src/index.js";
import {
  ddl,
  defineMigration,
  data,
  openNodeStorage,
} from "../src/node/index.js";

const v1Rows = hydb.table("mstep_rows", {
  id: id().primaryKey(),
  title: text().notNull(),
  archivedAt: timestamp(),
});
const v1Schema = hydb.schema({ rows: v1Rows });
const v2Rows = hydb.table("mstep_rows", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const v2Schema = hydb.schema({ rows: v2Rows });
const notedRows = hydb.table("mstep_rows", {
  id: id().primaryKey(),
  title: text().notNull(),
  note: text(),
});

test("dropColumn migration rewrites rows and preserves history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-drop-col-"));
  try {
    let storage = await openNodeStorage({ directory, schema: v1Schema });
    const start = await storage.snapshot();
    const saved = await storage.commit({
      branch: "main",
      expectedHead: start.commit,
      mutations: [
        storageMutation.insert(v1Rows, {
          id: "a",
          title: "Keep",
          archivedAt: new Date("2026-09-01T00:00:00Z"),
        }),
      ],
    });
    await start.close();
    await storage.close();
    storage = await openNodeStorage({
      directory,
      schema: v2Schema,
      migrations: [
        defineMigration({
          id: "0001-drop-archived-at",
          steps: [ddl.dropColumn("mstep_rows", "archivedAt", timestamp())],
        }),
      ],
    });
    const snapshot = await storage.snapshot();
    assert.deepEqual(await snapshot.get(v2Rows, ["a"]), {
      id: "a",
      title: "Keep",
    });
    assert.equal(snapshot.sequence, saved.sequence + 1);
    await snapshot.close();
    const historical = await storage.snapshot({ commit: saved.commit });
    assert.equal(
      (await historical.get(v1Rows, ["a"]))?.archivedAt?.toISOString(),
      "2026-09-01T00:00:00.000Z",
    );
    await historical.close();
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changeColumn migration upgrades the schema keeping row values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-change-"));
  const nullableTitle = hydb.table("mstep_rows", {
    id: id().primaryKey(),
    title: text(),
  });
  const nullableSchema = hydb.schema({ rows: nullableTitle });
  const requiredRows = hydb.table("mstep_rows", {
    id: id().primaryKey(),
    title: text().notNull(),
  });
  const requiredSchema = hydb.schema({ rows: requiredRows });
  try {
    let storage = await openNodeStorage({ directory, schema: nullableSchema });
    const start = await storage.snapshot();
    const saved = await storage.commit({
      branch: "main",
      expectedHead: start.commit,
      mutations: [
        storageMutation.insert(nullableTitle, { id: "a", title: "Value" }),
      ],
    });
    await start.close();
    await storage.close();
    storage = await openNodeStorage({
      directory,
      schema: requiredSchema,
      migrations: [
        defineMigration({
          id: "0001-require-title",
          steps: [
            ddl.changeColumn("mstep_rows", "title", text(), text().notNull()),
          ],
        }),
      ],
    });
    const snapshot = await storage.snapshot();
    assert.deepEqual(await snapshot.get(requiredRows, ["a"]), {
      id: "a",
      title: "Value",
    });
    assert.equal(snapshot.sequence, saved.sequence + 1);
    await snapshot.close();
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const noteMigrations = () => [
  defineMigration({
    id: "0001-notes",
    steps: [
      ddl.addColumn("mstep_rows", "note", text()),
      data(async (database) => {
        for await (const row of database.scan("mstep_rows")) {
          await database.update("mstep_rows", [row.id], {
            note: `from:${row.title}`,
          });
        }
      }),
    ],
  }),
];

test("data steps backfill as their own commit between schema steps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-data-"));
  try {
    let storage = await openNodeStorage({ directory, schema: v2Schema });
    const start = await storage.snapshot();
    const saved = await storage.commit({
      branch: "main",
      expectedHead: start.commit,
      mutations: [
        storageMutation.insert(v2Rows, { id: "a", title: "Keep" }),
        storageMutation.insert(v2Rows, { id: "b", title: "Also" }),
      ],
    });
    await start.close();
    await storage.close();
    storage = await openNodeStorage({
      directory,
      schema: hydb.schema({ rows: notedRows }),
      migrations: noteMigrations(),
    });
    // One commit per step: schema, then data.
    const snapshot = await storage.snapshot();
    assert.equal(snapshot.sequence, saved.sequence + 2);
    assert.deepEqual(await snapshot.get(notedRows, ["a"]), {
      id: "a",
      title: "Keep",
      note: "from:Keep",
    });
    assert.deepEqual(await snapshot.get(notedRows, ["b"]), {
      id: "b",
      title: "Also",
      note: "from:Also",
    });
    const migrated = snapshot.commit;
    await snapshot.close();
    await storage.close();
    // Reopening is idempotent: no migration commits are rewritten.
    storage = await openNodeStorage({
      directory,
      schema: hydb.schema({ rows: notedRows }),
      migrations: noteMigrations(),
    });
    assert.equal(await storage.head(), migrated);
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing data step leaves no partial commit and resumes at that step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-crash-"));
  const flag = join(directory, "fail-once");
  const crashMigrations = () => [
    defineMigration({
      id: "0001-notes",
      steps: [
        ddl.addColumn("mstep_rows", "note", text()),
        data(async (database) => {
          if (existsSync(flag)) throw new Error("boom");
          for await (const row of database.scan("mstep_rows")) {
            await database.update("mstep_rows", [row.id], { note: "filled" });
          }
        }),
      ],
    }),
  ];
  const notedSchema = hydb.schema({ rows: notedRows });
  try {
    let storage = await openNodeStorage({ directory, schema: v2Schema });
    const start = await storage.snapshot();
    const saved = await storage.commit({
      branch: "main",
      expectedHead: start.commit,
      mutations: [storageMutation.insert(v2Rows, { id: "a", title: "Keep" })],
    });
    await start.close();
    await storage.close();
    await writeFile(flag, "1");
    // The schema step commits, then the data step throws: open fails.
    await assert.rejects(
      openNodeStorage({
        directory,
        schema: notedSchema,
        migrations: crashMigrations(),
      }),
      /boom/,
    );
    // A retry without the failure resumes at the data step only: the schema
    // step is not reapplied (exactly one new commit) and the backfill runs.
    await rm(flag, { force: true });
    storage = await openNodeStorage({
      directory,
      schema: notedSchema,
      migrations: crashMigrations(),
    });
    const snapshot = await storage.snapshot();
    assert.equal(snapshot.sequence, saved.sequence + 2);
    assert.deepEqual(await snapshot.get(notedRows, ["a"]), {
      id: "a",
      title: "Keep",
      note: "filled",
    });
    await snapshot.close();
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dropTable migration removes the table while history keeps its rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-drop-tab-"));
  const tags = hydb.table("mstep_tags", {
    id: id().primaryKey(),
    label: text().notNull(),
  });
  const bothSchema = hydb.schema({ rows: v2Rows, tags });
  const rowsOnlySchema = hydb.schema({ rows: v2Rows });
  try {
    let storage = await openNodeStorage({ directory, schema: bothSchema });
    const start = await storage.snapshot();
    const saved = await storage.commit({
      branch: "main",
      expectedHead: start.commit,
      mutations: [
        storageMutation.insert(v2Rows, { id: "a", title: "Keep" }),
        storageMutation.insert(tags, { id: "t1", label: "gone" }),
      ],
    });
    await start.close();
    await storage.close();
    storage = await openNodeStorage({
      directory,
      schema: rowsOnlySchema,
      migrations: [
        defineMigration({
          id: "0001-drop-tags",
          steps: [ddl.dropTable(tags)],
        }),
      ],
    });
    const snapshot = await storage.snapshot();
    assert.deepEqual(await snapshot.get(v2Rows, ["a"]), {
      id: "a",
      title: "Keep",
    });
    await assert.rejects(snapshot.get(tags, ["t1"]), /Unknown table/);
    assert.equal(snapshot.sequence, saved.sequence + 1);
    await snapshot.close();
    const historical = await storage.snapshot({ commit: saved.commit });
    assert.deepEqual(await historical.get(tags, ["t1"]), {
      id: "t1",
      label: "gone",
    });
    await historical.close();
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
