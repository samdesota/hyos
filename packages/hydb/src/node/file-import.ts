import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnySchema } from "../schema.js";
import { AppendOnlyPageStore } from "./page-store.js";
import { ImmutableBPlusTree } from "./bplus-tree.js";
import { decodeValue, encodeValue } from "./codec.js";
import { readImportCatalog } from "./file-import-source.js";
import {
  fingerprintImportQueries,
  type ImportQueryResult,
} from "./import-verification.js";
import { schemaMetadata, type StoredCommit } from "./tree-storage-model.js";
import { NodeSnapshot } from "./tree-snapshot.js";
import { KeyValuePages, pageKey, pageSizeKey } from "./key-value-pages.js";
import { openLmdbKeyValueStore } from "./lmdb-key-value-store.js";
import {
  branchKey,
  commitKey,
  historyKey,
  metadataKey,
  put,
  retainKey,
  type Metadata,
} from "./key-value-layout.js";
import type { KeyValueStore } from "./key-value-store.js";

export type FileImportReport = {
  sourceBytes: number;
  pages: number;
  pageBytes: number;
  commits: number;
  branches: number;
  historicalSchemaCommits: number;
  queries: { branch: string; results: ImportQueryResult[] }[];
};

/** Offline import. Source must be quiescent; destination must not exist.
 * Never opens the source writable. Only reachable pages are copied, preserving
 * IDs, history, branch bases, indexes and named retains. Metadata is published
 * last, so an interrupted/failed import cannot open as a valid KV database.
 * Failures leave the new directory for inspection; retry with a fresh path. */
export async function importFileStorage(options: {
  sourceFile: string;
  destinationDirectory: string;
  schema: AnySchema;
  openStore?: (directory: string) => KeyValueStore;
  onProgress?: (phase: string, count: number) => void;
}): Promise<FileImportReport> {
  const sourcePath = resolve(options.sourceFile);
  const destination = resolve(options.destinationDirectory);
  const identity = async () => {
    const s = await stat(sourcePath, { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
  };
  const schema = schemaMetadata(options.schema);
  const original = await identity();
  const source = await AppendOnlyPageStore.openReadOnly(sourcePath);
  const sourceTree = new ImmutableBPlusTree(source, {
    cacheBytes: 16 * 1024 * 1024,
  });
  let target: KeyValueStore | undefined;
  let targetTree: ImmutableBPlusTree | undefined;
  const openStore = options.openStore ?? openLmdbKeyValueStore;
  try {
    const catalog = await readImportCatalog(source);
    // Old-schema history remains byte-for-byte intact. Only active heads must
    // match: this importer does not run schema migrations.
    let historicalSchemaCommits = 0;
    const heads = new Set(
      [...catalog.branches.values()].map((branch) => branch.head),
    );
    for (const [id, offset] of catalog.commits) {
      const commit = decodeValue(
        (await source.read(offset, "commit")).payload,
      ) as StoredCommit;
      if (commit.manifest.schema !== schema.fingerprint) {
        if (heads.has(id))
          throw new Error(
            `Branch head ${id} uses a different schema; migrate the source before importing`,
          );
        historicalSchemaCommits++;
      }
    }
    await mkdir(destination, { mode: 0o700 }); // exclusive; never overwrite an existing destination
    target = openStore(destination);
    await target.batch([put("import/incomplete", true)]);
    const report: FileImportReport = {
      sourceBytes: source.endOffset,
      pages: 0,
      pageBytes: 0,
      commits: 0,
      branches: catalog.branches.size,
      historicalSchemaCommits,
      queries: [],
    };
    const seen = new Set<number>();
    for (const [id, offset] of catalog.commits) {
      const commit = decodeValue(
        (await source.read(offset, "commit")).payload,
      ) as StoredCommit;
      const pending = Object.values(commit.manifest.tables).flatMap((t) => [
        t.primary,
        ...Object.values(t.indexes),
      ]);
      while (pending.length) {
        const page = pending.pop()!;
        if (page === null || seen.has(page)) continue;
        const payload = await source.readPage(page);
        pending.push(...(await sourceTree.pageChildren(page)));
        const size = new Uint8Array(8);
        new DataView(size.buffer).setFloat64(0, payload.byteLength);
        await target.batch([
          { type: "put", key: pageKey(page), value: payload },
          { type: "put", key: pageSizeKey(pageKey(page)), value: size },
        ]);
        seen.add(page);
        report.pages++;
        report.pageBytes += payload.byteLength;
        if (report.pages % 128 === 0)
          options.onProgress?.("pages", report.pages);
      }
      await target.batch([put(commitKey(id), { ...commit, id })]);
      report.commits++;
    }
    for (const [name, branch] of catalog.branches)
      await target.batch([put(branchKey(name), branch)]);
    for (const entry of catalog.history.values())
      await target.batch([
        put(historyKey(entry.branch, entry.sequence), entry.id),
      ]);
    for (const [name, id] of Object.entries(catalog.retains))
      await target.batch([put(retainKey(name), id)]);
    await target.close();
    target = openStore(destination);
    // Read back every copied page and commit after reopening, including history
    // not queried by the current schema's branch-head query suite.
    options.onProgress?.("verify-pages", report.pages);
    for (const page of seen)
      assert.deepEqual(
        await target.get(pageKey(page)),
        Uint8Array.from(await source.readPage(page)),
        `Page mismatch ${page}`,
      );
    for (const [id, offset] of catalog.commits) {
      const commit = decodeValue(
        (await source.read(offset, "commit")).payload,
      ) as StoredCommit;
      assert.deepEqual(
        await target.get(commitKey(id)),
        encodeValue({ ...commit, id }),
        `Commit mismatch ${id}`,
      );
    }
    for (const [name, branch] of catalog.branches)
      assert.deepEqual(
        await target.get(branchKey(name)),
        encodeValue(branch),
        "Branch mismatch",
      );
    for (const entry of catalog.history.values())
      assert.deepEqual(
        await target.get(historyKey(entry.branch, entry.sequence)),
        encodeValue(entry.id),
        "History mismatch",
      );
    for (const [name, id] of Object.entries(catalog.retains))
      assert.deepEqual(
        await target.get(retainKey(name)),
        encodeValue(id),
        "Retention mismatch",
      );
    targetTree = new ImmutableBPlusTree(
      new KeyValuePages(target, source.endOffset + 1),
      { cacheBytes: 16 * 1024 * 1024 },
    );
    for (const [name, branch] of catalog.branches) {
      const commit = decodeValue(
        (await source.read(catalog.commits.get(branch.head)!, "commit"))
          .payload,
      ) as StoredCommit;
      const imported = decodeValue(
        (await target.get(commitKey(branch.head)))!,
      ) as StoredCommit;
      const before = new NodeSnapshot(
        branch.head,
        branch.sequence,
        name,
        commit.manifest,
        sourceTree,
        schema.tables,
        async () => {},
      );
      const after = new NodeSnapshot(
        branch.head,
        branch.sequence,
        name,
        imported.manifest,
        targetTree,
        schema.tables,
        async () => {},
      );
      try {
        const expected = await fingerprintImportQueries(
          before,
          schema.tables,
          (query, rows) => options.onProgress?.("source-query:" + query, rows),
        );
        const actual = await fingerprintImportQueries(
          after,
          schema.tables,
          (query, rows) => options.onProgress?.("target-query:" + query, rows),
        );
        assert.deepEqual(actual, expected, `Query mismatch on branch ${name}`);
        report.queries.push({ branch: name, results: actual });
        options.onProgress?.("verified-queries", actual.length);
      } finally {
        await before.close();
        await after.close();
      }
    }
    if ((await identity()) !== original)
      throw new Error(
        "Source changed during import; stop its writer and retry",
      );
    await writeFile(
      join(destination, "import-report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    const metadata: Metadata = {
      format: "hydb-kv-1",
      schema: schema.fingerprint,
      nextPageId: source.endOffset + 1,
      revision: 0,
      retention: catalog.retention,
    };
    await target.batch(
      [
        put(metadataKey, metadata),
        { type: "delete", key: "import/incomplete" },
      ],
      [{ key: metadataKey, expected: undefined }],
    );
    return report;
  } finally {
    targetTree?.dispose();
    sourceTree.dispose();
    try {
      await target?.close();
    } finally {
      await source.close();
    }
  }
}
