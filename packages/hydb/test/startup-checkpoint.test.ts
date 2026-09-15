import assert from "node:assert/strict";
import {
  appendFile,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { hydb, id, text, storageMutation } from "../src/index.js";
import { openNodeStorage } from "../src/node/index.js";
import { readStartupCheckpoint } from "../src/node/startup-checkpoint.js";
import { AppendOnlyPageStore } from "../src/node/page-store.js";

const rows = hydb.table("checkpoint_rows", {
  id: id().primaryKey(),
  value: text().notNull(),
});
const schema = hydb.schema({ rows });

test("checkpoint startup skips the historical log scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-checkpoint-scan-"));
  const original = AppendOnlyPageStore.prototype.records;
  try {
    const first = await openNodeStorage({ directory, schema });
    await first.close();
    const checkpoint = await readStartupCheckpoint(
      join(directory, "hydb.data"),
    );
    assert.ok(checkpoint);
    const offsets: number[] = [];
    AppendOnlyPageStore.prototype.records = function (types, start) {
      offsets.push(start ?? 0);
      return original.call(this, types, start);
    };
    const reopened = await openNodeStorage({ directory, schema });
    await reopened.close();
    assert.deepEqual(offsets, [checkpoint.offset]);
  } finally {
    AppendOnlyPageStore.prototype.records = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint reopens current and historical rows and replays newer commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-checkpoint-"));
  try {
    let storage = await openNodeStorage({ directory, schema });
    const initial = await storage.snapshot();
    const first = await storage.commit({
      branch: "main",
      expectedHead: initial.commit,
      mutations: [storageMutation.insert(rows, { id: "a", value: "first" })],
    });
    await initial.close();
    await storage.close();
    const path = join(directory, "hydb.data");
    const checkpoint = await readFile(`${path}.checkpoint`);
    assert.ok(await readStartupCheckpoint(path));
    storage = await openNodeStorage({ directory, schema });
    await storage.commit({
      branch: "main",
      expectedHead: first.commit,
      mutations: [storageMutation.insert(rows, { id: "b", value: "tail" })],
    });
    await storage.close();
    // Simulate a durable commit after the most recent checkpoint, plus a torn tail.
    await writeFile(`${path}.checkpoint`, checkpoint);
    await appendFile(path, "HYDB");
    storage = await openNodeStorage({ directory, schema });
    const current = await storage.snapshot();
    assert.equal((await current.get(rows, ["b"]))?.value, "tail");
    const historical = await storage.snapshot({ commit: first.commit });
    assert.equal(await historical.get(rows, ["b"]), undefined);
    assert.equal((await historical.get(rows, ["a"]))?.value, "first");
    await historical.close();
    await current.close();
    await storage.collectGarbage();
    await storage.close();
    storage = await openNodeStorage({ directory, schema });
    const afterCollection = await storage.snapshot();
    assert.equal((await afterCollection.get(rows, ["b"]))?.value, "tail");
    await afterCollection.close();
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing, corrupt and foreign checkpoints safely fall back to the log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-checkpoint-"));
  const other = await mkdtemp(join(tmpdir(), "hydb-checkpoint-other-"));
  try {
    let storage = await openNodeStorage({ directory, schema });
    const initial = await storage.snapshot();
    await storage.commit({
      branch: "main",
      expectedHead: initial.commit,
      mutations: [storageMutation.insert(rows, { id: "a", value: "saved" })],
    });
    await initial.close();
    await storage.close();
    const path = join(directory, "hydb.data");
    const otherStorage = await openNodeStorage({ directory: other, schema });
    await otherStorage.close();
    for (const mode of ["missing", "corrupt", "foreign", "checksum"]) {
      if (mode === "missing") await rm(`${path}.checkpoint`);
      else if (mode === "corrupt")
        await writeFile(`${path}.checkpoint`, "broken");
      else if (mode === "foreign")
        await copyFile(
          join(other, "hydb.data.checkpoint"),
          `${path}.checkpoint`,
        );
      else {
        const envelope = JSON.parse(
          await readFile(`${path}.checkpoint`, "utf8"),
        );
        envelope.payload += " ";
        await writeFile(`${path}.checkpoint`, JSON.stringify(envelope));
      }
      assert.equal(await readStartupCheckpoint(path), undefined);
      storage = await openNodeStorage({ directory, schema });
      const snapshot = await storage.snapshot();
      assert.equal((await snapshot.get(rows, ["a"]))?.value, "saved");
      await snapshot.close();
      await storage.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
