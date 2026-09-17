import assert from "node:assert/strict";
import test from "node:test";
import { KeyValuePages, pageKey } from "../src/node/key-value-pages.js";
import { memoryKeyValueStore } from "../src/node/memory-key-value-store.js";

test("staging reclaims obsolete roots while preserving shared and published pages", async () => {
  const store = memoryKeyValueStore();
  const pages = new KeyValuePages(store, 1);
  try {
    const source = Uint8Array.of(7);
    const published = await pages.writePage(source);
    source.fill(9);
    await store.batch(pages.operations());
    pages.discard();
    const shared = await pages.writePage(Uint8Array.of(2));
    const obsolete = await pages.writePage(Uint8Array.of(3), [
      shared,
      published,
    ]);
    const current = await pages.writePage(Uint8Array.of(4), [
      shared,
      published,
    ]);
    const index = await pages.writePage(Uint8Array.of(5), [shared]);
    pages.retainRoots([current, index]);
    await assert.rejects(pages.readPage(obsolete), /Missing page/);
    assert.deepEqual(await pages.readPage(published), Uint8Array.of(7));
    const read = await pages.readPage(shared);
    read.fill(99);
    assert.deepEqual(await pages.readPage(shared), Uint8Array.of(2));
    assert.deepEqual(
      pages
        .operations()
        .filter((op) => op.key.startsWith("page/"))
        .map((op) => op.key),
      [shared, current, index].map(pageKey),
    );
    await store.batch(pages.operations());
    pages.discard();
    const replacement = await pages.writePage(Uint8Array.of(6));
    pages.retainRoots([replacement]);
    assert.deepEqual(await pages.readPage(current), Uint8Array.of(4));
    pages.discard();
    assert.ok((await pages.writePage(Uint8Array.of(8))) > replacement);
  } finally {
    await store.close();
  }
});
