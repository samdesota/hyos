import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hydb,
  id,
  integer,
  text,
  timestamp,
  storageMutation,
} from "../src/index.js";
import { ddl, defineMigration, openNodeStorage } from "../src/node/index.js";

const originalRows = hydb.table("mopen_rows", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const originalSchema = hydb.schema({ rows: originalRows });

const intermediateRows = hydb.table("mopen_rows", {
  id: id().primaryKey(),
  title: text().notNull(),
  archivedAt: timestamp(),
});
const intermediateSchema = hydb.schema({ rows: intermediateRows });

const latestRows = hydb.table("mopen_rows", {
  id: id().primaryKey(),
  title: text().notNull(),
  archivedAt: timestamp(),
  promptTokens: integer(),
});
const latestSchema = hydb.schema({ rows: latestRows });

const columnMigrations = [
  defineMigration({
    id: "0001-archived-at",
    steps: [ddl.addColumn("mopen_rows", "archivedAt", timestamp())],
  }),
  defineMigration({
    id: "0002-prompt-tokens",
    steps: [ddl.addColumn("mopen_rows", "promptTokens", integer())],
  }),
];

for (const intermediate of [false, true]) {
  test(`migration list upgrades ${intermediate ? "intermediate" : "original"} schemas without resetting existing values`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydb-migration-list-"));
    const archivedAt = new Date("2026-09-01T00:00:00Z");
    try {
      let storage = await openNodeStorage({
        directory,
        schema: intermediate ? intermediateSchema : originalSchema,
      });
      const head = await storage.head();
      const saved = await storage.commit({
        branch: "main",
        expectedHead: head,
        mutations: [
          intermediate
            ? storageMutation.insert(intermediateRows, {
                id: "a",
                title: "Keep",
                archivedAt,
              })
            : storageMutation.insert(originalRows, { id: "a", title: "Keep" }),
        ],
      });
      await storage.createBranch({ name: "work", from: saved.commit });
      await storage.close();
      storage = await openNodeStorage({
        directory,
        schema: latestSchema,
        migrations: columnMigrations,
      });
      for (const branch of ["main", "work"]) {
        const snapshot = await storage.snapshot({ branch });
        assert.deepEqual(await snapshot.get(latestRows, ["a"]), {
          id: "a",
          title: "Keep",
          archivedAt: intermediate ? archivedAt : null,
          promptTokens: null,
        });
        await snapshot.close();
      }
      const snapshot = await storage.snapshot();
      assert.equal(snapshot.sequence, saved.sequence + (intermediate ? 1 : 2));
      const migrated = snapshot.commit;
      await snapshot.close();
      const history = await storage.snapshot({ commit: saved.commit });
      assert.equal((await history.get(originalRows, ["a"]))?.title, "Keep");
      await history.close();
      await storage.close();
      // Reopening is idempotent: no additional migration commits appear.
      storage = await openNodeStorage({
        directory,
        schema: latestSchema,
        migrations: columnMigrations,
      });
      assert.equal(await storage.head(), migrated);
      await storage.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("migration list rejects a schema change with no matching migration without writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-miss-"));
  try {
    const storage = await openNodeStorage({
      directory,
      schema: originalSchema,
    });
    await storage.close();
    const path = join(directory, "hydb.data");
    const before = (await stat(path)).size;
    await assert.rejects(
      openNodeStorage({ directory, schema: latestSchema, migrations: [] }),
      /schema does not match/,
    );
    assert.equal((await stat(path)).size, before);
    // An unrelated schema change is also rejected: the migration chain's base
    // fingerprint does not match the stored head.
    const wrong = hydb.table("mopen_rows", {
      id: id().primaryKey(),
      title: timestamp().notNull(),
      archivedAt: timestamp(),
      promptTokens: integer(),
    });
    await assert.rejects(
      openNodeStorage({
        directory,
        schema: hydb.schema({ rows: wrong }),
        migrations: columnMigrations,
      }),
      /does not match|Unknown column|does not match added column/,
    );
    assert.equal((await stat(path)).size, before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration list adds tables and accepts new rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-table-"));
  const logs = hydb.table("mopen_logs", {
    id: id().primaryKey(),
    note: text().notNull(),
  });
  const tags = hydb.table("mopen_tags", {
    id: id().primaryKey(),
    label: text().notNull(),
  });
  const oldSchema = hydb.schema({ logs });
  const schema = hydb.schema({ logs, tags });
  try {
    let storage = await openNodeStorage({ directory, schema: oldSchema });
    const start = await storage.snapshot();
    const saved = await storage.commit({
      branch: "main",
      expectedHead: start.commit,
      mutations: [storageMutation.insert(logs, { id: "a", note: "Keep" })],
    });
    await start.close();
    await storage.close();
    storage = await openNodeStorage({
      directory,
      schema,
      migrations: [
        defineMigration({
          id: "0001-tags",
          steps: [ddl.addTable(tags)],
        }),
      ],
    });
    const snapshot = await storage.snapshot();
    assert.deepEqual(await snapshot.get(logs, ["a"]), {
      id: "a",
      note: "Keep",
    });
    await snapshot.close();
    const head = await storage.head();
    await storage.commit({
      branch: "main",
      expectedHead: head,
      mutations: [storageMutation.insert(tags, { id: "t1", label: "ok" })],
    });
    const after = await storage.snapshot();
    assert.deepEqual(await after.get(tags, ["t1"]), { id: "t1", label: "ok" });
    const migrated = after.commit;
    await after.close();
    await storage.close();
    storage = await openNodeStorage({
      directory,
      schema,
      migrations: [
        defineMigration({ id: "0001-tags", steps: [ddl.addTable(tags)] }),
      ],
    });
    assert.equal(await storage.head(), migrated);
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration list resumes from an intermediate table-addition schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-chain-"));
  const logs = hydb.table("mopen_chain_logs", { id: id().primaryKey() });
  const tags = hydb.table("mopen_chain_tags", { id: id().primaryKey() });
  const notes = hydb.table("mopen_chain_notes", { id: id().primaryKey() });
  const intermediate = hydb.schema({ logs, tags });
  const latest = hydb.schema({ logs, tags, notes });
  try {
    let storage = await openNodeStorage({ directory, schema: intermediate });
    await storage.close();
    storage = await openNodeStorage({
      directory,
      schema: latest,
      migrations: [
        defineMigration({ id: "0001-tags", steps: [ddl.addTable(tags)] }),
        defineMigration({ id: "0002-notes", steps: [ddl.addTable(notes)] }),
      ],
    });
    const head = await storage.head();
    await storage.commit({
      branch: "main",
      expectedHead: head,
      mutations: [storageMutation.insert(notes, { id: "resumed" })],
    });
    const snapshot = await storage.snapshot();
    assert.deepEqual(await snapshot.get(notes, ["resumed"]), { id: "resumed" });
    await snapshot.close();
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration list cannot be combined with legacy options", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-opts-"));
  try {
    const storage = await openNodeStorage({
      directory,
      schema: originalSchema,
    });
    await storage.close();
    await assert.rejects(
      openNodeStorage({
        directory,
        schema: latestSchema,
        migrations: columnMigrations,
        addNullableColumns: { mopen_rows: ["archivedAt"] },
      }),
      /not both/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration list resumes a legacy-group storage through a stale progress marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-marker-"));
  try {
    // A storage written by the deprecated inline options carries progress
    // markers indexed against the grouped step list, which does not align
    // with the declarative per-op steps of an equivalent migration list.
    let storage = await openNodeStorage({
      directory,
      schema: originalSchema,
    });
    const head = await storage.head();
    await storage.commit({
      branch: "main",
      expectedHead: head,
      mutations: [
        storageMutation.insert(originalRows, { id: "a", title: "Keep" }),
      ],
    });
    await storage.close();
    storage = await openNodeStorage({
      directory,
      schema: latestSchema,
      addNullableColumns: { mopen_rows: ["archivedAt", "promptTokens"] },
    });
    await storage.close();
    // The declarative list produces one step per column (two steps) while the
    // inline options committed both columns as one step: the stored marker
    // index is stale, so resume must fall back to the schema fingerprint.
    const reopened = await openNodeStorage({
      directory,
      schema: latestSchema,
      migrations: columnMigrations,
    });
    const snapshot = await reopened.snapshot();
    assert.deepEqual(await snapshot.get(latestRows, ["a"]), {
      id: "a",
      title: "Keep",
      archivedAt: null,
      promptTokens: null,
    });
    await snapshot.close();
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
