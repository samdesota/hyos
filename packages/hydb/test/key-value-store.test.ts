import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KeyValueConflictError,
  memoryKeyValueStore,
  openLmdbKeyValueStore,
} from "../src/node/index.js";

for (const backend of ["memory", "lmdb"] as const) {
  test(`${backend}: binary KV contract, atomic conditions, scans and ownership`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydb-kv-contract-"));
    const store =
      backend === "memory"
        ? memoryKeyValueStore()
        : openLmdbKeyValueStore(directory);
    try {
      const value = Uint8Array.of(0, 255, 13);
      const write = store.batch([
        { type: "put", key: "a/1", value },
        { type: "put", key: "a/3", value: Uint8Array.of(3) },
      ]);
      value.fill(99);
      await write;
      assert.deepEqual(await store.get("a/1"), Uint8Array.of(0, 255, 13));
      const read = (await store.get("a/1"))!;
      read.fill(9);
      assert.deepEqual(await store.getMany(["a/3", "absent", "a/1", "a/3"]), [
        Uint8Array.of(3),
        undefined,
        Uint8Array.of(0, 255, 13),
        Uint8Array.of(3),
      ]);
      await assert.rejects(
        store.batch(
          [
            { type: "delete", key: "a/1" },
            { type: "put", key: "bad", value },
          ],
          [{ key: "a/3", expected: Uint8Array.of(4) }],
        ),
        KeyValueConflictError,
      );
      assert.equal(await store.get("bad"), undefined);
      assert.deepEqual(await store.get("a/1"), Uint8Array.of(0, 255, 13));
      await assert.rejects(
        store.batch(
          [{ type: "delete", key: "a/1" }],
          [{ key: "a/1", expected: undefined }],
        ),
        KeyValueConflictError,
      );
      await store.batch(
        [{ type: "put", key: "empty", value: new Uint8Array() }],
        [{ key: "empty", expected: undefined }],
      );
      assert.deepEqual(await store.get("empty"), new Uint8Array());
      const scan = store.scan("a/")[Symbol.asyncIterator]();
      assert.equal((await scan.next()).value?.key, "a/1");
      await store.batch([
        { type: "put", key: "a/2", value },
        { type: "delete", key: "a/3" },
        { type: "put", key: "é", value },
        { type: "put", key: "z", value },
      ]);
      assert.deepEqual((await scan.next()).value, {
        key: "a/3",
        value: Uint8Array.of(3),
      });
      assert.equal((await scan.next()).done, true);
      assert.deepEqual(
        (await collect(store.scan())).map((entry) => entry.key),
        ["a/1", "a/2", "empty", "z", "é"],
      );
      assert.deepEqual(
        (await collect(store.scan("é"))).map((entry) => entry.key),
        ["é"],
      );
      assert.deepEqual(
        (await collect(store.scan("a/", { after: "a/1", limit: 1 }))).map(
          (entry) => entry.key,
        ),
        ["a/2"],
      );
      assert.deepEqual(
        await collect(store.scan("a/", { after: "z", limit: 1 })),
        [],
      );
      await assert.rejects(
        collect(store.scan("a/", { limit: 0 })),
        /positive safe integer/,
      );
      await store.batch([
        { type: "put", key: "ordered", value },
        { type: "delete", key: "ordered" },
      ]);
      assert.equal(await store.get("ordered"), undefined);
      await assert.rejects(
        store.batch([
          { type: "delete", key: "a/1" },
          { type: "put", key: "x".repeat(481), value },
        ]),
        /UTF-8/,
      );
      assert.ok(await store.get("a/1"));
      await assert.rejects(store.get("\ud800"), /UTF-8/);
      const pending = store.batch([
        { type: "put", key: "last", value: Uint8Array.of(42) },
      ]);
      await store.close();
      await pending;
      await assert.rejects(store.get("last"), /closed/);
      if (backend === "lmdb") {
        const reopened = openLmdbKeyValueStore(directory);
        try {
          assert.deepEqual(await reopened.get("last"), Uint8Array.of(42));
        } finally {
          await reopened.close();
        }
      }
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}
