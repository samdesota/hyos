import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hydb,
  id,
  text,
  integer,
  timestamp,
  index,
  storageMutation,
} from "../src/index.js";
import {
  importFileStorage,
  openNodeStorage,
  openKeyValueStorage,
  openLmdbKeyValueStore,
} from "../src/node/index.js";

const sessions = hydb.table("sessions", {
  id: id().primaryKey(),
  title: text().notNull(),
  createdAt: timestamp().notNull(),
});
const chunks = hydb.table(
  "chunks",
  {
    id: id().primaryKey(),
    sessionId: id().notNull(),
    position: integer().notNull(),
    content: text(),
  },
  (c) => [index("by_session").on(c.sessionId, c.position)],
);
const schema = hydb.schema({ sessions, chunks });
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("file import preserves history/branches and verifies data-derived session queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "hydb-import-"));
  const sourceDir = join(root, "source"),
    destination = join(root, "target");
  const source = await openNodeStorage({
    directory: sourceDir,
    schema,
    maxEntries: 4,
  });
  try {
    const first = await source.commit({
      expectedHead: await source.head(),
      mutations: [
        storageMutation.insert(sessions, {
          id: "s1",
          title: "Unicode 🐱",
          createdAt: new Date(123456),
        }),
        storageMutation.insert(sessions, {
          id: "s2",
          title: "Empty session",
          createdAt: new Date(234567),
        }),
        ...Array.from({ length: 25 }, (_, i) =>
          storageMutation.insert(chunks, {
            id: `c${i.toString().padStart(2, "0")}`,
            sessionId: "s1",
            position: i,
            content: i === 0 ? null : "line\n" + "x".repeat(2000),
          }),
        ),
      ],
    });
    await source.retain({ name: "before-edit", commit: first.commit });
    await source.createBranch({ name: "feature/a", from: first.commit });
    const last = await source.commit({
      expectedHead: first.commit,
      mutations: [
        storageMutation.update(chunks, ["c01"], {
          id: "c01",
          sessionId: "s1",
          position: 1,
          content: "edited",
        }),
        storageMutation.delete(chunks, ["c02"]),
      ],
    });
    await source.close();
    const file = join(sourceDir, "hydb.data");
    const before = digest(await readFile(file));
    const report = await importFileStorage({
      sourceFile: file,
      destinationDirectory: destination,
      schema,
    });
    assert.equal(digest(await readFile(file)), before);
    assert.equal(report.branches, 2);
    assert.ok(
      report.queries.every((b) =>
        b.results.some(
          (q) => q.query === "chunks:by_session:prefix:0" && q.rows > 0,
        ),
      ),
    );
    const target = await openKeyValueStorage({
      directory: destination,
      schema,
    });
    try {
      assert.equal(await target.head(), last.commit);
      assert.equal(await target.head("feature/a"), first.commit);
      const snapshot = await target.snapshot();
      assert.equal((await snapshot.get(chunks, ["c01"]))?.content, "edited");
      assert.equal(await snapshot.get(chunks, ["c02"]), undefined);
      const messages = [];
      for await (const batch of snapshot.scan({
        type: "index",
        table: chunks,
        index: "by_session",
        key: ["s1"],
      }))
        messages.push(...batch);
      assert.equal(messages.length, 24);
      assert.deepEqual(
        messages.map((r) => r.position),
        [0, 1, ...Array.from({ length: 22 }, (_, i) => i + 3)],
      );
      await snapshot.close();
      const old = await target.snapshot({ commit: first.commit });
      assert.ok(await old.get(chunks, ["c02"]));
      await old.close();
      const stream = target
        .changes({ after: first.sequence })
        [Symbol.asyncIterator]();
      assert.equal((await stream.next()).value?.commit, last.commit);
      await stream.return?.();
      await target.collectGarbage();
      const retained = await target.snapshot({ commit: first.commit });
      await retained.close();
      await target.commit({
        expectedHead: last.commit,
        mutations: [
          storageMutation.insert(sessions, {
            id: "new",
            title: "post-import",
            createdAt: new Date(),
          }),
        ],
      });
    } finally {
      await target.close();
    }
    await assert.rejects(
      importFileStorage({
        sourceFile: file,
        destinationDirectory: destination,
        schema,
      }),
      /EEXIST/,
    );
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt input stays unchanged and failed imports cannot open", async () => {
  const root = await mkdtemp(join(tmpdir(), "hydb-import-failure-"));
  const source = await openNodeStorage({
    directory: join(root, "source"),
    schema,
  });
  try {
    await source.commit({
      expectedHead: await source.head(),
      mutations: [
        storageMutation.insert(sessions, {
          id: "s",
          title: "test",
          createdAt: new Date(0),
        }),
      ],
    });
    await source.close();
    const file = join(root, "source", "hydb.data");
    let opens = 0;
    await assert.rejects(
      importFileStorage({
        sourceFile: file,
        destinationDirectory: join(root, "bad"),
        schema,
        openStore(directory) {
          const backend = openLmdbKeyValueStore(directory);
          if (++opens === 1) return backend;
          return {
            ...backend,
            async get(key) {
              const value = await backend.get(key);
              if (key.startsWith("page/") && value) value[0] ^= 1;
              return value;
            },
          };
        },
      }),
      /Page mismatch/,
    );
    await assert.rejects(
      openKeyValueStorage({ directory: join(root, "bad"), schema }),
      /nonempty/,
    );
    await assert.rejects(
      importFileStorage({
        sourceFile: file,
        destinationDirectory: join(root, "changed"),
        schema,
        onProgress(phase) {
          if (phase === "verified-queries")
            appendFileSync(file, Uint8Array.of(1, 2, 3));
        },
      }),
      /Source changed during import/,
    );
    await assert.rejects(
      openKeyValueStorage({ directory: join(root, "changed"), schema }),
      /nonempty/,
    );

    const before = digest(await readFile(file));
    await assert.rejects(
      importFileStorage({
        sourceFile: file,
        destinationDirectory: join(root, "truncated"),
        schema,
      }),
      /Corrupt storage header/,
    );
    assert.equal(digest(await readFile(file)), before);
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("import preserves older-schema history without rewriting its fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "hydb-import-schema-"));
  const oldTable = hydb.table("items", { id: id().primaryKey() });
  const newTable = hydb.table("items", { id: id().primaryKey(), note: text() });
  const oldSchema = hydb.schema({ items: oldTable });
  const newSchema = hydb.schema({ items: newTable });
  let source = await openNodeStorage({
    directory: join(root, "source"),
    schema: oldSchema,
  });
  try {
    const oldHead = await source.head();
    await source.close();
    await assert.rejects(
      importFileStorage({
        sourceFile: join(root, "source", "hydb.data"),
        destinationDirectory: join(root, "wrong"),
        schema: newSchema,
      }),
      /Branch head.*different schema/,
    );
    source = await openNodeStorage({
      directory: join(root, "source"),
      schema: newSchema,
      addNullableColumns: { items: ["note"] },
    });
    await source.commit({
      expectedHead: await source.head(),
      mutations: [storageMutation.insert(newTable, { id: "one", note: null })],
    });
    await source.close();
    const destination = join(root, "target");
    const report = await importFileStorage({
      sourceFile: join(root, "source", "hydb.data"),
      destinationDirectory: destination,
      schema: newSchema,
    });
    assert.ok(report.historicalSchemaCommits > 0);
    const target = await openKeyValueStorage({
      directory: destination,
      schema: newSchema,
    });
    try {
      const snapshot = await target.snapshot();
      assert.deepEqual(await snapshot.get(newTable, ["one"]), {
        id: "one",
        note: null,
      });
      await snapshot.close();
      await assert.rejects(target.snapshot({ commit: oldHead }), /schema/);
      await target.collectGarbage();
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});
