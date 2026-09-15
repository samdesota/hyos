import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ImmutableBPlusTree,
  type PageId,
  type TreePageStore,
  type TreeRoot,
} from "../src/node/index.js";
import { AppendOnlyPageStore } from "../src/node/page-store.js";

// IDs deliberately descend and have no relationship to payload byte offsets.
class MemoryPages implements TreePageStore {
  private nextId = 1_000_000;
  private readonly pages = new Map<PageId, Uint8Array>();

  async writePage(payload: Uint8Array): Promise<PageId> {
    const id = this.nextId;
    this.nextId -= 7;
    this.pages.set(id, Uint8Array.from(payload));
    return id;
  }

  async readPage(id: PageId): Promise<Uint8Array> {
    const bytes = this.pages.get(id);
    if (bytes === undefined) throw new Error(`Missing page ${id}`);
    return bytes.slice();
  }
}

const key = (value: number) => Buffer.from(String(value).padStart(4, "0"));

async function rows(tree: ImmutableBPlusTree, root: TreeRoot) {
  const result: Array<[string, string]> = [];
  for await (const entry of tree.scan(root)) {
    result.push([
      Buffer.from(entry.key).toString(),
      Buffer.from(entry.value).toString(),
    ]);
  }
  return result;
}

test("tree roots work across non-file stores and copy into a durable file store", async () => {
  const memory = new MemoryPages();
  const tree = new ImmutableBPlusTree(memory, { maxEntries: 4, cacheBytes: 0 });
  const expected: Array<[string, string]> = Array.from(
    { length: 48 },
    (_, i) => [key(i).toString(), `value-${i}`],
  );
  const original = await tree.mutate(
    null,
    expected.map(([key, value]) => ({
      type: "put",
      key: Buffer.from(key),
      value: Buffer.from(value),
    })),
  );
  const changed = await tree.mutate(original, [
    { type: "delete", key: key(0) },
    { type: "put", key: key(47), value: Buffer.from("updated") },
  ]);
  const expectedChanged = expected.slice(1);
  expectedChanged[46] = [key(47).toString(), "updated"];
  tree.dispose();

  const reopened = new ImmutableBPlusTree(memory, { cacheBytes: 0 });
  assert.deepEqual(await rows(reopened, original), expected);
  assert.deepEqual(await rows(reopened, changed), expectedChanged);
  assert.equal(await reopened.get(changed, key(0)), undefined);
  assert.equal(
    Buffer.from((await reopened.get(changed, key(47)))!).toString(),
    "updated",
  );

  const directory = await mkdtemp(join(tmpdir(), "hydb-page-interface-"));
  const path = join(directory, "pages.data");
  let file = await AppendOnlyPageStore.open(path);
  let target = new ImmutableBPlusTree(file, { cacheBytes: 0 });
  try {
    const copied = await reopened.copyRootsTo(
      [original, changed, changed, null],
      target,
    );
    assert.equal(copied.roots[1], copied.roots[2]);
    assert.equal(copied.roots[3], null);
    await file.sync();
    target.dispose();
    await file.close();
    file = await AppendOnlyPageStore.open(path);
    target = new ImmutableBPlusTree(file, { cacheBytes: 0 });
    assert.deepEqual(await rows(target, copied.roots[0]!), expected);
    assert.deepEqual(await rows(target, copied.roots[1]!), expectedChanged);
  } finally {
    reopened.dispose();
    target.dispose();
    await file.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("file page adapter preserves record validation and isolates buffers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-page-adapter-"));
  const file = await AppendOnlyPageStore.open(join(directory, "pages.data"));
  const pages: TreePageStore = file;
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    const id = await pages.writePage(bytes);
    bytes.fill(0);
    const read = await pages.readPage(id);
    assert.deepEqual([...read], [1, 2, 3]);
    read.fill(9);
    assert.deepEqual([...(await pages.readPage(id))], [1, 2, 3]);
    const metadata = await file.append("meta", new Uint8Array([4]));
    await assert.rejects(pages.readPage(metadata), /expected page/);
    await assert.rejects(
      pages.readPage(file.endOffset),
      /Missing storage record/,
    );
  } finally {
    await file.close();
    await rm(directory, { recursive: true, force: true });
  }
});
