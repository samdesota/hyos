import { setImmediate } from "node:timers/promises";
import type { GarbageCollectionReport, RetentionPolicy } from "../storage.js";
import type { ImmutableBPlusTree } from "./bplus-tree.js";
import { decodeValue } from "./codec.js";
import {
  branchKey,
  historyKey,
  put,
  type Branch,
  type Subscriber,
} from "./key-value-layout.js";
import type { KeyValueOperation, KeyValueStore } from "./key-value-store.js";
import { pageSizeKey } from "./key-value-pages.js";
import type { StoredCommit } from "./tree-storage-model.js";

type Entry = Readonly<{ key: string; value: Uint8Array }>;

export type KeyValueGarbageCollectionReport = GarbageCollectionReport &
  Readonly<{
    pagesCollected: number;
    /** Older databases may lack sidecar sizes. Their payloads are never loaded
     * just for accounting; byte totals are lower bounds in that case. */
    accountingComplete: boolean;
    pagesWithoutSize: number;
    historyEntriesCollected: number;
    /** Byte fields count observed page/commit payloads, not LMDB file size. */
    accounting: "logical-page-and-commit-payloads";
  }>;

type Host = {
  store: KeyValueStore;
  tree: ImmutableBPlusTree;
  branches: Map<string, Branch>;
  pins: ReadonlyMap<string, number>;
  retains: ReadonlyMap<string, string>;
  subscribers: ReadonlySet<Subscriber>;
  retiring: Set<string>;
  pendingFloors: Map<string, number>;
  batchSize: number;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  publish(operations: readonly KeyValueOperation[]): Promise<void>;
  checkpoint(): void;
  capture(): { nextPageId: number; retention: RetentionPolicy };
};

/**
 * Restartable mark/sweep without a temporary data file or a long writer lock.
 * Only prune commits first. Once pruning ends, all surviving old roots are
 * stable for this cycle: new branches/snapshots can only name those survivors.
 * New writes derive from protected heads and allocate above the page cutoff.
 * No deletion plan/mark set is reused after a restart; partial sweeps are safe.
 */
export async function collectKeyValueGarbage(
  host: Host,
): Promise<KeyValueGarbageCollectionReport> {
  const start = await host.enqueue(async () => ({
    ...host.capture(),
    sequences: new Map(
      [...host.branches].map(([name, branch]) => [name, branch.sequence]),
    ),
    now: Date.now(),
  }));
  const report = {
    commitsCollected: 0,
    recordsCopied: 0,
    pagesCollected: 0,
    accountingComplete: true,
    pagesWithoutSize: 0,
    historyEntriesCollected: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesReclaimed: 0,
    accounting: "logical-page-and-commit-payloads" as const,
  };
  const yieldSlice = async () => {
    await setImmediate();
    host.checkpoint();
  };
  // Every cursor is closed before yielding to writers; no scan transaction is
  // held over the cycle. Keys are immutable and pages never reuse an ID.
  async function* batches(prefix: string): AsyncIterable<Entry[]> {
    let after: string | undefined;
    while (true) {
      host.checkpoint();
      const entries: Entry[] = [];
      for await (const entry of host.store.scan(prefix, {
        after,
        limit: host.batchSize,
      }))
        entries.push(entry);
      if (!entries.length) return;
      after = entries.at(-1)!.key;
      yield entries;
      await yieldSlice();
    }
  }

  // Fixed retention horizon: even if a head advances during the cycle, its
  // starting commit remains protected. Its old pages cover all shared children
  // a concurrently generated root might use below the allocation cutoff.
  const policyKeeps = (commit: StoredCommit): boolean => {
    const policy = start.retention;
    if (policy.mode === "forever") return true;
    const sequence = start.sequences.get(commit.branch);
    return (
      sequence === undefined ||
      commit.sequence > sequence - policy.keepAtLeast ||
      (policy.keepYoungerThanMs !== undefined &&
        (commit.committedAtMs ?? Infinity) >=
          start.now - policy.keepYoungerThanMs)
    );
  };

  for await (const entries of batches("commit/")) {
    report.bytesBefore += entries.reduce(
      (total, entry) => total + entry.value.byteLength,
      0,
    );
    await host.enqueue(async () => {
      const roots = new Set([...host.pins.keys(), ...host.retains.values()]);
      for (const branch of host.branches.values()) {
        roots.add(branch.head);
        roots.add(branch.base);
      }
      const operations: KeyValueOperation[] = [];
      const removed: { id: string; bytes: number }[] = [];
      const branches = new Map<string, Branch>();
      for (const entry of entries) {
        const commit = decodeValue(entry.value) as StoredCommit;
        const id = entry.key.slice("commit/".length);
        if (roots.has(id) || policyKeeps(commit)) continue;
        if (
          [...host.subscribers].some(
            (reader) =>
              reader.branch === commit.branch &&
              commit.sequence > reader.retainAfter,
          )
        )
          continue;
        const branch =
          branches.get(commit.branch) ?? host.branches.get(commit.branch);
        if (!branch) throw new Error("GC encountered a commit with no branch");
        operations.push(
          { type: "delete", key: entry.key },
          { type: "delete", key: historyKey(commit.branch, commit.sequence) },
        );
        branches.set(commit.branch, {
          ...branch,
          floor: Math.max(branch.floor ?? 0, commit.sequence),
        });
        removed.push({ id, bytes: entry.value.byteLength });
      }
      if (!removed.length) return;
      for (const [name, branch] of branches)
        operations.push(put(branchKey(name), branch));
      // Admission barrier must precede the first await: a snapshot or stream
      // cannot pin history after selection but before its deletion commits.
      for (const { id } of removed) host.retiring.add(id);
      for (const [name, branch] of branches)
        host.pendingFloors.set(name, branch.floor!);
      try {
        await host.publish(operations);
        for (const [name, branch] of branches) host.branches.set(name, branch);
        report.commitsCollected += removed.length;
        report.historyEntriesCollected += removed.length;
        report.bytesReclaimed += removed.reduce(
          (total, entry) => total + entry.bytes,
          0,
        );
      } finally {
        for (const { id } of removed) host.retiring.delete(id);
        for (const name of branches.keys()) host.pendingFloors.delete(name);
      }
    });
  }

  const marked = new Set<number>();
  let visited = 0;
  for await (const entries of batches("commit/")) {
    for (const entry of entries) {
      const commit = decodeValue(entry.value) as StoredCommit;
      const pending = Object.values(commit.manifest.tables).flatMap((table) => [
        table.primary,
        ...Object.values(table.indexes),
      ]);
      while (pending.length) {
        const id = pending.pop()!;
        if (id === null || id >= start.nextPageId || marked.has(id)) continue;
        marked.add(id);
        pending.push(...(await host.tree.pageChildren(id)));
        if (++visited % host.batchSize === 0) await yieldSlice();
      }
    }
  }

  let after: string | undefined;
  while (true) {
    host.checkpoint();
    const keys: string[] = [];
    for await (const key of host.store.scanKeys("page/", {
      after,
      limit: host.batchSize,
    }))
      keys.push(key);
    if (!keys.length) break;
    after = keys.at(-1)!;
    const candidates = keys.filter(
      (key) => Number(key.slice("page/".length)) < start.nextPageId,
    );
    const sizes = await host.store.getMany(candidates.map(pageSizeKey));
    const operations: KeyValueOperation[] = [];
    let reclaimed = 0,
      collected = 0;
    for (let i = 0; i < candidates.length; i++) {
      const key = candidates[i]!;
      const bytes = sizes[i];
      let size = 0;
      if (bytes === undefined) {
        report.accountingComplete = false;
        report.pagesWithoutSize++;
      } else {
        if (bytes.byteLength !== 8)
          throw new Error(`Invalid page size for ${key}`);
        size = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).getFloat64(0);
        if (!Number.isSafeInteger(size) || size < 0)
          throw new Error(`Invalid page size for ${key}`);
      }
      report.bytesBefore += size;
      if (!marked.has(Number(key.slice("page/".length)))) {
        operations.push(
          { type: "delete", key },
          { type: "delete", key: pageSizeKey(key) },
        );
        reclaimed += size;
        collected++;
      }
    }
    if (operations.length) {
      await host.enqueue(() => host.publish(operations));
      report.pagesCollected += collected;
      report.bytesReclaimed += reclaimed;
    }
    if (candidates.length < keys.length) break;
    await yieldSlice();
  }
  report.bytesAfter = report.bytesBefore - report.bytesReclaimed;
  return report;
}
