import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ImmutableBPlusTree,
  type TreeRange,
  type TreeRoot,
} from "../src/node/bplus-tree.js";
import { AppendOnlyPageStore } from "../src/node/page-store.js";

const numberKey = (value: number): Uint8Array => {
  const key = Buffer.alloc(4);
  key.writeUInt32BE(value);
  return key;
};

const numberValue = (value: number): Uint8Array =>
  Buffer.from(`value-${value}`);

async function entries(
  tree: ImmutableBPlusTree,
  root: TreeRoot,
  range: TreeRange = {},
): Promise<Array<readonly [number, string]>> {
  const result: Array<readonly [number, string]> = [];
  for await (const entry of tree.scan(root, range)) {
    result.push([
      Buffer.from(entry.key).readUInt32BE(),
      Buffer.from(entry.value).toString(),
    ]);
  }
  return result;
}

async function withTree(
  options: ConstructorParameters<typeof ImmutableBPlusTree>[1],
  run: (
    tree: ImmutableBPlusTree,
    store: AppendOnlyPageStore,
    path: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "hydb-bplus-tree-"));
  const path = join(directory, "tree.data");
  const store = await AppendOnlyPageStore.open(path);
  try {
    await run(new ImmutableBPlusTree(store, options), store, path);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("mutations create immutable roots and no-op deletes preserve identity", async () => {
  await withTree({ maxEntries: 4 }, async (tree) => {
    assert.equal(await tree.get(null, numberKey(1)), undefined);
    assert.deepEqual(await entries(tree, null), []);

    const first = await tree.mutate(null, [
      { type: "put", key: numberKey(1), value: Buffer.from("first") },
    ]);
    const second = await tree.mutate(first, [
      { type: "put", key: numberKey(1), value: Buffer.from("second") },
    ]);
    const noOp = await tree.mutate(second, [
      { type: "delete", key: numberKey(999) },
    ]);

    assert.equal(
      Buffer.from((await tree.get(first, numberKey(1)))!).toString(),
      "first",
    );
    assert.equal(
      Buffer.from((await tree.get(second, numberKey(1)))!).toString(),
      "second",
    );
    assert.equal(noOp, second);

    const empty = await tree.mutate(second, [
      { type: "delete", key: numberKey(1) },
    ]);
    assert.equal(empty, null);
    assert.equal(
      Buffer.from((await tree.get(second, numberKey(1)))!).toString(),
      "second",
    );
  });
});

test("a mutation batch observes its preceding mutations", async () => {
  await withTree({ maxEntries: 4 }, async (tree) => {
    const root = await tree.mutate(null, [
      { type: "put", key: numberKey(2), value: Buffer.from("initial") },
      { type: "put", key: numberKey(2), value: Buffer.from("replaced") },
      { type: "delete", key: numberKey(2) },
      { type: "put", key: numberKey(2), value: Buffer.from("final") },
      { type: "delete", key: numberKey(3) },
    ]);

    assert.deepEqual(await entries(tree, root), [[2, "final"]]);
    assert.equal(await tree.mutate(root, []), root);
  });
});

test("range scans distinguish inclusive and exclusive bounds in both directions", async () => {
  await withTree({ maxEntries: 4 }, async (tree) => {
    const root = await tree.mutate(
      null,
      Array.from({ length: 20 }, (_, value) => ({
        type: "put" as const,
        key: numberKey(value),
        value: numberValue(value),
      })),
    );

    assert.deepEqual(
      await entries(tree, root, { gte: numberKey(5), lt: numberKey(10) }),
      [5, 6, 7, 8, 9].map((value) => [value, `value-${value}`]),
    );
    assert.deepEqual(
      await entries(tree, root, { gt: numberKey(5), lte: numberKey(10) }),
      [6, 7, 8, 9, 10].map((value) => [value, `value-${value}`]),
    );
    assert.deepEqual(
      await entries(tree, root, {
        gte: numberKey(5),
        lte: numberKey(10),
        reverse: true,
        limit: 3,
      }),
      [10, 9, 8].map((value) => [value, `value-${value}`]),
    );
    assert.deepEqual(
      await entries(tree, root, { gt: numberKey(10), lt: numberKey(10) }),
      [],
    );
    assert.deepEqual(await entries(tree, root, { limit: 0 }), []);
  });
});

test("binary keys are ordered bytewise without text or prefix assumptions", async () => {
  await withTree({ maxEntries: 4 }, async (tree) => {
    const pairs = [
      [Buffer.from([0xff]), Buffer.from([0, 1, 2])],
      [Buffer.from([]), Buffer.from("empty")],
      [Buffer.from([0]), Buffer.from("zero")],
      [Buffer.from([0, 0]), Buffer.from("zero-prefix")],
      [Buffer.from([0, 0xff]), Buffer.from("zero-ff")],
    ] as const;
    const root = await tree.mutate(
      null,
      pairs.map(([key, value]) => ({ type: "put" as const, key, value })),
    );

    const actual = [];
    for await (const entry of tree.scan(root)) {
      actual.push([
        Buffer.from(entry.key).toString("hex"),
        Buffer.from(entry.value).toString("hex"),
      ]);
    }
    assert.deepEqual(actual, [
      ["", Buffer.from("empty").toString("hex")],
      ["00", Buffer.from("zero").toString("hex")],
      ["0000", Buffer.from("zero-prefix").toString("hex")],
      ["00ff", Buffer.from("zero-ff").toString("hex")],
      ["ff", "000102"],
    ]);
  });
});

test("roots remain readable after the page store is reopened", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-bplus-reopen-"));
  const path = join(directory, "tree.data");
  let store = await AppendOnlyPageStore.open(path);
  try {
    let tree = new ImmutableBPlusTree(store, { maxEntries: 4 });
    const oldRoot = await tree.mutate(
      null,
      Array.from({ length: 40 }, (_, value) => ({
        type: "put" as const,
        key: numberKey(value),
        value: numberValue(value),
      })),
    );
    await store.sync();
    await store.close();

    store = await AppendOnlyPageStore.open(path);
    tree = new ImmutableBPlusTree(store, { maxEntries: 4 });
    assert.equal(
      Buffer.from((await tree.get(oldRoot, numberKey(23)))!).toString(),
      "value-23",
    );

    const newRoot = await tree.mutate(oldRoot, [
      { type: "delete", key: numberKey(23) },
      { type: "put", key: numberKey(50), value: numberValue(50) },
    ]);
    assert.equal(await tree.get(newRoot, numberKey(23)), undefined);
    assert.equal(
      Buffer.from((await tree.get(oldRoot, numberKey(23)))!).toString(),
      "value-23",
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cascading splits and merges preserve every historical root", async () => {
  await withTree({ maxEntries: 4 }, async (tree) => {
    const insertionOrder = Array.from(
      { length: 257 },
      (_, value) => value,
    ).sort((left, right) => {
      const leftBucket = (left * 97) % 257;
      const rightBucket = (right * 97) % 257;
      return leftBucket - rightBucket;
    });
    const populated = await tree.mutate(
      null,
      insertionOrder.map((value) => ({
        type: "put" as const,
        key: numberKey(value),
        value: numberValue(value),
      })),
    );
    assert.deepEqual(
      (await entries(tree, populated)).map(([key]) => key),
      Array.from({ length: 257 }, (_, value) => value),
    );

    const edgeDeletes = Array.from({ length: 80 }, (_, offset) =>
      offset % 2 === 0 ? offset / 2 : 256 - (offset - 1) / 2,
    );
    const afterEdges = await tree.mutate(
      populated,
      edgeDeletes.map((value) => ({
        type: "delete" as const,
        key: numberKey(value),
      })),
    );
    const remainingAfterEdges = Array.from(
      { length: 177 },
      (_, offset) => offset + 40,
    );
    assert.deepEqual(
      (await entries(tree, afterEdges)).map(([key]) => key),
      remainingAfterEdges,
    );

    const middleOut = await tree.mutate(
      afterEdges,
      remainingAfterEdges
        .filter((value) => value % 2 === 0)
        .map((value) => ({
          type: "delete" as const,
          key: numberKey(value),
        })),
    );
    assert.deepEqual(
      (await entries(tree, middleOut)).map(([key]) => key),
      remainingAfterEdges.filter((value) => value % 2 === 1),
    );

    const empty = await tree.mutate(
      middleOut,
      remainingAfterEdges
        .filter((value) => value % 2 === 1)
        .map((value) => ({
          type: "delete" as const,
          key: numberKey(value),
        })),
    );
    assert.equal(empty, null);
    assert.equal((await entries(tree, populated)).length, 257);
    assert.equal((await entries(tree, afterEdges)).length, 177);
  });
});

test("random mutation histories match an independent ordered map model", async (t) => {
  for (const maxEntries of [4, 5, 8]) {
    await t.test(`maxEntries=${maxEntries}`, async () => {
      await withTree({ maxEntries }, async (tree) => {
        let randomState = (0x9e37_79b9 ^ maxEntries) >>> 0;
        const random = (): number => {
          randomState ^= randomState << 13;
          randomState ^= randomState >>> 17;
          randomState ^= randomState << 5;
          return randomState >>> 0;
        };

        let root: TreeRoot = null;
        const model = new Map<number, string>();
        const history: Array<readonly [TreeRoot, ReadonlyMap<number, string>]> =
          [];

        for (let operation = 0; operation < 900; operation += 1) {
          const key = random() % 180;
          if (random() % 100 < 62) {
            const value = `op-${operation}-${random() % 10_000}`;
            root = await tree.mutate(root, [
              {
                type: "put",
                key: numberKey(key),
                value: Buffer.from(value),
              },
            ]);
            model.set(key, value);
          } else {
            root = await tree.mutate(root, [
              { type: "delete", key: numberKey(key) },
            ]);
            model.delete(key);
          }

          if (operation % 75 === 0) history.push([root, new Map(model)]);
          if (operation % 30 !== 0) continue;

          const expected = [...model].sort(([left], [right]) => left - right);
          assert.deepEqual(await entries(tree, root), expected);

          const lower = random() % 140;
          const upper = lower + (random() % 40);
          const limit = random() % 12;
          assert.deepEqual(
            await entries(tree, root, {
              gt: numberKey(lower),
              lte: numberKey(upper),
              reverse: true,
              limit,
            }),
            expected
              .filter(([key]) => key > lower && key <= upper)
              .reverse()
              .slice(0, limit),
          );
        }

        for (const [historicalRoot, historicalModel] of history) {
          assert.deepEqual(
            await entries(tree, historicalRoot),
            [...historicalModel].sort(([left], [right]) => left - right),
          );
        }
      });
    });
  }
});
