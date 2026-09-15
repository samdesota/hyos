import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hydb,
  id,
  text,
  timestamp,
  integer,
  storageMutation,
} from "../src/index.js";
import { ddl, defineMigration, openNodeStorage } from "../src/node/index.js";

const oldRows = hydb.table("rows", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const rows = hydb.table("rows", {
  id: id().primaryKey(),
  title: text().notNull(),
  archivedAt: timestamp(),
});
const oldSchema = hydb.schema({ rows: oldRows });
const schema = hydb.schema({ rows });
const addNullableColumns = { rows: ["archivedAt"] };

for (const intermediate of [false, true]) {
  test(`ordered migrations upgrade ${intermediate ? "intermediate" : "original"} schemas without resetting existing values`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydb-ordered-migration-"));
    const latestRows = hydb.table("rows", {
      id: id().primaryKey(),
      title: text().notNull(),
      archivedAt: timestamp(),
      promptTokens: integer(),
    });
    const latest = hydb.schema({ rows: latestRows });
    const columnMigrations = [
      defineMigration({
        id: "0001-archived-at",
        steps: [ddl.addColumn("rows", "archivedAt", timestamp())],
      }),
      defineMigration({
        id: "0002-prompt-tokens",
        steps: [ddl.addColumn("rows", "promptTokens", integer())],
      }),
    ];
    const archivedAt = new Date("2026-09-01T00:00:00Z");
    try {
      let storage = await openNodeStorage({
        directory,
        schema: intermediate ? schema : oldSchema,
      });
      const head = await storage.head();
      const saved = await storage.commit({
        branch: "main",
        expectedHead: head,
        mutations: [
          intermediate
            ? storageMutation.insert(rows, {
                id: "a",
                title: "Keep",
                archivedAt,
              })
            : storageMutation.insert(oldRows, { id: "a", title: "Keep" }),
        ],
      });
      await storage.createBranch({ name: "work", from: saved.commit });
      await storage.close();
      storage = await openNodeStorage({
        directory,
        schema: latest,
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
      assert.equal((await history.get(oldRows, ["a"]))?.title, "Keep");
      await history.close();
      await storage.close();
      storage = await openNodeStorage({
        directory,
        schema: latest,
        migrations: columnMigrations,
      });
      assert.equal(await storage.head(), migrated);
      await storage.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("explicit nullable migration preserves rows and history and only runs once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-"));
  try {
    let storage = await openNodeStorage({ directory, schema: oldSchema });
    const start = await storage.snapshot();
    const saved = await storage.commit({
      branch: "main",
      expectedHead: start.commit,
      mutations: [
        storageMutation.insert(oldRows, { id: "a", title: "Preserved" }),
      ],
    });
    await start.close();
    await storage.createBranch({ name: "work", from: saved.commit });
    await storage.close();
    await assert.rejects(
      openNodeStorage({ directory, schema }),
      /schema does not match/,
    );
    storage = await openNodeStorage({ directory, schema, addNullableColumns });
    const current = await storage.snapshot();
    assert.deepEqual(await current.get(rows, ["a"]), {
      id: "a",
      title: "Preserved",
      archivedAt: null,
    });
    assert.equal(current.sequence, saved.sequence + 1);
    const branch = await storage.snapshot({ branch: "work" });
    assert.deepEqual(await branch.get(rows, ["a"]), {
      id: "a",
      title: "Preserved",
      archivedAt: null,
    });
    await branch.close();
    const historical = await storage.snapshot({ commit: saved.commit });
    assert.deepEqual(await historical.get(oldRows, ["a"]), {
      id: "a",
      title: "Preserved",
    });
    await historical.close();
    const head = current.commit;
    await current.close();
    await storage.close();
    storage = await openNodeStorage({ directory, schema, addNullableColumns });
    const reopened = await storage.snapshot();
    assert.equal(reopened.commit, head);
    await reopened.close();
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration rejects unrelated changes and required additions without writing data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-migration-invalid-"));
  try {
    const storage = await openNodeStorage({ directory, schema: oldSchema });
    await storage.close();
    const path = join(directory, "hydb.data");
    const before = (await stat(path)).size;
    const incompatible = hydb.table("rows", {
      id: id().primaryKey(),
      title: timestamp().notNull(),
      archivedAt: timestamp(),
    });
    await assert.rejects(
      openNodeStorage({
        directory,
        schema: hydb.schema({ rows: incompatible }),
        addNullableColumns,
      }),
      /schema does not match/,
    );
    const required = hydb.table("rows", {
      id: id().primaryKey(),
      title: text().notNull(),
      archivedAt: timestamp().notNull(),
    });
    await assert.rejects(
      openNodeStorage({
        directory,
        schema: hydb.schema({ rows: required }),
        addNullableColumns,
      }),
      /nullable, non-indexed/,
    );
    assert.equal((await stat(path)).size, before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("added tables open existing storages and accept new rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-table-migration-"));
  const logs = hydb.table("logs", {
    id: id().primaryKey(),
    note: text().notNull(),
  });
  const tags = hydb.table("tags", {
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
    // Without declaring the addition the fingerprint mismatch is rejected.
    await assert.rejects(
      openNodeStorage({ directory, schema }),
      /schema does not match/,
    );
    storage = await openNodeStorage({
      directory,
      schema,
      addedTables: ["tags"],
    });
    const snapshot = await storage.snapshot();
    assert.deepEqual(await snapshot.get(logs, ["a"]), {
      id: "a",
      note: "Keep",
    });
    await snapshot.close();
    // The new table accepts writes immediately after migration.
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
    // Reopening is idempotent: the migration commit is already the head.
    storage = await openNodeStorage({
      directory,
      schema,
      addedTables: ["tags"],
    });
    assert.equal(await storage.head(), migrated);
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordered table migrations resume from an intermediate schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-table-chain-"));
  const logs = hydb.table("chain_logs", { id: id().primaryKey() });
  const tags = hydb.table("chain_tags", { id: id().primaryKey() });
  const notes = hydb.table("chain_notes", { id: id().primaryKey() });
  const intermediate = hydb.schema({ logs, tags });
  const latest = hydb.schema({ logs, tags, notes });
  try {
    let storage = await openNodeStorage({ directory, schema: intermediate });
    await storage.close();
    storage = await openNodeStorage({
      directory,
      schema: latest,
      addedTableMigrations: [["chain_tags"], ["chain_notes"]],
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

for (const afterTables of [false, true]) {
  test(`nullable migration after added tables upgrades ${afterTables ? "post-table" : "original"} schema`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydb-post-table-column-"));
    const original = hydb.table("chain_sessions", {
      id: id().primaryKey(),
      title: text().notNull(),
    });
    const withEarlierColumn = hydb.table("chain_sessions", {
      id: id().primaryKey(),
      title: text().notNull(),
      archivedAt: timestamp(),
    });
    const latestSessions = hydb.table("chain_sessions", {
      id: id().primaryKey(),
      title: text().notNull(),
      archivedAt: timestamp(),
      seenStatusDetail: text(),
    });
    const tabs = hydb.table("chain_tabs", { id: id().primaryKey() });
    const latest = hydb.schema({ sessions: latestSessions, tabs });
    const migrations = [
      defineMigration({
        id: "0001-archived-at",
        steps: [ddl.addColumn("chain_sessions", "archivedAt", timestamp())],
      }),
      defineMigration({
        id: "0002-chain-tabs",
        steps: [ddl.addTable(tabs)],
      }),
      defineMigration({
        id: "0003-seen-status-detail",
        steps: [ddl.addColumn("chain_sessions", "seenStatusDetail", text())],
      }),
    ];
    const archivedAt = new Date("2026-09-01T00:00:00Z");
    try {
      let storage = await openNodeStorage({
        directory,
        schema: afterTables
          ? hydb.schema({ sessions: withEarlierColumn, tabs })
          : hydb.schema({ sessions: original }),
      });
      const head = await storage.head();
      await storage.commit({
        branch: "main",
        expectedHead: head,
        mutations: [
          afterTables
            ? storageMutation.insert(withEarlierColumn, {
                id: "saved",
                title: "Keep",
                archivedAt,
              })
            : storageMutation.insert(original, { id: "saved", title: "Keep" }),
        ],
      });
      await storage.close();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        storage = await openNodeStorage({
          directory,
          schema: latest,
          migrations,
        });
        const snapshot = await storage.snapshot();
        assert.deepEqual(await snapshot.get(latestSessions, ["saved"]), {
          id: "saved",
          title: "Keep",
          archivedAt: afterTables ? archivedAt : null,
          seenStatusDetail: null,
        });
        await snapshot.close();
        await storage.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
