import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hydb, id, text, timestamp, storageMutation } from "../src/index.js";
import { openNodeStorage } from "../src/node/index.js";

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
