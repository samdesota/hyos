import type { AnySchema } from "../schema.js";
import type { MemoryManager } from "../memory.js";
import {
  HistoryUnavailableError,
  StorageConflictError,
  type ChangeStreamOptions,
  type CommitBatch,
  type CommitRequest,
  type GarbageCollectionReport,
  type RetentionPolicy,
  type SnapshotSelector,
  type StorageDatabase,
  type StorageSnapshot,
} from "../storage.js";
import { ImmutableBPlusTree } from "./bplus-tree.js";
import { decodeValue, encodeValue } from "./codec.js";
import { KeyValuePages } from "./key-value-pages.js";
import {
  type KeyValueOperation,
  type KeyValueStore,
} from "./key-value-store.js";
import { openLmdbKeyValueStore } from "./lmdb-key-value-store.js";
import { NodeSnapshot } from "./tree-snapshot.js";
import {
  applyTreeMutations,
  cloneManifest,
  foreverRetention,
  newCommitId,
  sameRetention,
  schemaMetadata,
  validateRetention,
  type StoredCommit,
  type TableMetadata,
} from "./tree-storage-model.js";

type Branch = { head: string; base: string; sequence: number };
type Metadata = {
  format: "hydb-kv-1";
  schema: string;
  nextPageId: number;
  revision: number;
  retention: RetentionPolicy;
};
type Subscriber = {
  branch: string;
  after: number;
  retainAfter: number;
  queue: CommitBatch[];
  wake?: () => void;
};
const metadataKey = "metadata";
const commitKey = (id: string) => `commit/${id}`;
const branchKey = (name: string) => `branch/${encodeURIComponent(name)}`;
const historyPrefix = (name: string) => `history/${encodeURIComponent(name)}/`;
const historyKey = (name: string, sequence: number) =>
  `${historyPrefix(name)}${sequence.toString().padStart(16, "0")}`;
const retainKey = (name: string) => `retain/${encodeURIComponent(name)}`;
const put = (key: string, value: unknown): KeyValueOperation => ({
  type: "put",
  key,
  value: encodeValue(value),
});

export type KeyValueStorageOptions = Readonly<{
  schema: AnySchema;
  retention?: RetentionPolicy;
  cacheBytes?: number;
  maxEntries?: number;
  memory?: MemoryManager;
}> &
  (
    | Readonly<{ directory: string; store?: never }>
    | Readonly<{ store: KeyValueStore; directory?: never }>
  );

/**
 * Opt-in prototype: immutable HyDB trees backed by a replaceable KV store.
 * Directory opens use LMDB. An injected store is owned and closed by this engine.
 * One active writer per database; a metadata condition rejects stale publication
 * from another instance. Existing file databases and schema migrations are not
 * imported. Reclamation is deliberately deferred to step 3.
 */
export class KeyValueStorageDatabase implements StorageDatabase {
  private readonly branches = new Map<string, Branch>();
  private readonly pins = new Map<string, number>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly pages: KeyValuePages;
  private readonly tree: ImmutableBPlusTree;
  private queue: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private closed = false;
  private failed = false;

  private constructor(
    private readonly store: KeyValueStore,
    private metadata: Metadata,
    private metadataBytes: Uint8Array,
    private readonly tables: ReadonlyMap<string, TableMetadata>,
    options: KeyValueStorageOptions,
  ) {
    this.pages = new KeyValuePages(store, metadata.nextPageId);
    this.tree = new ImmutableBPlusTree(this.pages, options);
  }

  static async open(
    options: KeyValueStorageOptions,
  ): Promise<KeyValueStorageDatabase> {
    const requested =
      options.retention === undefined
        ? undefined
        : validateRetention(options.retention);
    const schema = schemaMetadata(options.schema);
    const store = options.store ?? openLmdbKeyValueStore(options.directory!);
    let database: KeyValueStorageDatabase | undefined;
    try {
      let bytes = await store.get(metadataKey);
      if (bytes === undefined) {
        // Refuse to reinterpret an unrelated/nonempty store as a new database.
        for await (const _ of store.scan())
          throw new Error(
            "Cannot initialize a nonempty key-value store without HyDB metadata",
          );
        const id = newCommitId();
        const initial: StoredCommit = {
          id,
          committedAtMs: Date.now(),
          parent: null,
          branch: "main",
          sequence: 0,
          changes: [],
          manifest: {
            schema: schema.fingerprint,
            tables: Object.fromEntries(
              [...schema.tables.values()].map((table) => [
                table.name,
                {
                  primary: null,
                  indexes: Object.fromEntries(
                    table.indexes.map((index) => [index.name, null]),
                  ),
                },
              ]),
            ),
          },
        };
        const metadata: Metadata = {
          format: "hydb-kv-1",
          schema: schema.fingerprint,
          nextPageId: 1,
          revision: 0,
          retention: requested ?? foreverRetention,
        };
        bytes = encodeValue(metadata);
        await store.batch(
          [
            put(commitKey(id), initial),
            put(branchKey("main"), { head: id, base: id, sequence: 0 }),
            { type: "put", key: metadataKey, value: bytes },
          ],
          [{ key: metadataKey, expected: undefined }],
        );
      }
      const metadata = decodeValue(bytes) as Metadata;
      if (
        metadata.format !== "hydb-kv-1" ||
        !Number.isSafeInteger(metadata.nextPageId) ||
        metadata.nextPageId < 1 ||
        !Number.isSafeInteger(metadata.revision)
      ) {
        throw new Error("Invalid key-value storage metadata");
      }
      if (metadata.schema !== schema.fingerprint)
        throw new TypeError(
          "Storage schema does not match the supplied schema (KV prototype requires an unchanged schema)",
        );
      validateRetention(metadata.retention);
      database = new KeyValueStorageDatabase(
        store,
        metadata,
        bytes,
        schema.tables,
        options,
      );
      for await (const entry of store.scan("branch/")) {
        const name = decodeURIComponent(entry.key.slice("branch/".length));
        const branch = decodeValue(entry.value) as Branch;
        await database.readCommit(branch.head);
        database.branches.set(name, branch);
      }
      if (!database.branches.has("main"))
        throw new Error("Missing main branch");
      if (
        requested !== undefined &&
        !sameRetention(requested, metadata.retention)
      ) {
        await database.publish([], requested);
      }
      return database;
    } catch (error) {
      database?.tree.dispose();
      await store.close();
      throw error;
    }
  }

  async head(branch = "main"): Promise<string> {
    this.assertOpen();
    return this.branch(branch).head;
  }

  async snapshot(selector?: SnapshotSelector): Promise<StorageSnapshot> {
    this.assertOpen();
    const name =
      selector !== undefined && "commit" in selector
        ? undefined
        : (selector?.branch ?? "main");
    const branch = name === undefined ? undefined : this.branch(name);
    const id =
      selector !== undefined && "commit" in selector
        ? selector.commit
        : branch!.head;
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    const release = async () => {
      const count = this.pins.get(id)!;
      if (count === 1) this.pins.delete(id);
      else this.pins.set(id, count - 1);
    };
    try {
      const commit = await this.readCommit(id);
      return new NodeSnapshot(
        id,
        branch?.sequence ?? commit.sequence,
        name,
        commit.manifest,
        this.tree,
        this.tables,
        release,
      );
    } catch (error) {
      await release();
      throw error;
    }
  }

  createBranch(request: { name: string; from: string }): Promise<void> {
    return this.enqueue(async () => {
      if (this.branches.has(request.name))
        throw new TypeError(`Branch already exists: ${request.name}`);
      await this.readCommit(request.from);
      const branch = { head: request.from, base: request.from, sequence: 0 };
      await this.publish([put(branchKey(request.name), branch)]);
      this.branches.set(request.name, branch);
    });
  }

  commit(request: CommitRequest): Promise<CommitBatch> {
    return this.enqueue(async () => {
      const name = request.branch ?? "main";
      const current = this.branch(name);
      if (
        request.expectedHead !== undefined &&
        request.expectedHead !== current.head
      )
        throw new StorageConflictError(request.expectedHead, current.head);
      if (
        request.expectedHead === undefined &&
        request.expectedVersion !== current.sequence
      )
        throw new StorageConflictError(
          request.expectedVersion ?? -1,
          current.sequence,
        );
      const parent = await this.readCommit(current.head);
      const manifest = cloneManifest(parent.manifest);
      try {
        const changes = await applyTreeMutations(
          this.tree,
          this.tables,
          manifest,
          request.mutations,
        );
        const stored: StoredCommit = {
          id: newCommitId(),
          committedAtMs: Date.now(),
          parent: current.head,
          branch: name,
          sequence: current.sequence + 1,
          manifest,
          changes,
        };
        const branch = {
          ...current,
          head: stored.id!,
          sequence: stored.sequence,
        };
        await this.publish([
          ...this.pages.operations(),
          put(commitKey(stored.id!), stored),
          put(historyKey(name, stored.sequence), stored.id!),
          put(branchKey(name), branch),
        ]);
        this.branches.set(name, branch);
        const batch = this.toBatch(stored);
        for (const subscriber of this.subscribers) {
          if (subscriber.branch !== name || stored.sequence <= subscriber.after)
            continue;
          subscriber.queue.push(batch);
          subscriber.after = stored.sequence;
          subscriber.wake?.();
          subscriber.wake = undefined;
        }
        return batch;
      } finally {
        this.pages.discard();
      }
    });
  }

  async *changes(options: ChangeStreamOptions): AsyncIterable<CommitBatch> {
    this.assertOpen();
    const branch = options.branch ?? "main";
    if (!Number.isSafeInteger(options.after) || options.after < 0)
      throw new TypeError("Change cursor must be a nonnegative integer");
    const through = this.branch(branch).sequence;
    const subscriber: Subscriber = {
      branch,
      after: Math.max(through, options.after),
      retainAfter: options.after,
      queue: [],
    };
    const wake = () => subscriber.wake?.();
    options.signal?.addEventListener("abort", wake, { once: true });
    this.subscribers.add(subscriber);
    try {
      // Read immutable history records individually: never hold an LMDB reader
      // transaction open while a consumer pauses between yielded changes.
      for (let sequence = options.after + 1; sequence <= through; sequence++) {
        if (this.closed || options.signal?.aborted) return;
        const value = await this.store.get(historyKey(branch, sequence));
        if (value === undefined)
          throw new HistoryUnavailableError(`${branch}:${sequence}`);
        const commit = await this.readCommit(decodeValue(value) as string);
        subscriber.retainAfter = sequence;
        yield this.toBatch(commit);
      }
      while (!this.closed && !options.signal?.aborted) {
        const batch = subscriber.queue.shift();
        if (batch) {
          subscriber.retainAfter = batch.sequence;
          yield batch;
        } else
          await new Promise<void>((resolve) => {
            subscriber.wake = resolve;
          });
      }
    } finally {
      options.signal?.removeEventListener("abort", wake);
      this.subscribers.delete(subscriber);
    }
  }

  retain(request: { name: string; commit: string }): Promise<void> {
    return this.enqueue(async () => {
      if (!request.name.trim())
        throw new TypeError("Retention name cannot be empty");
      await this.readCommit(request.commit);
      const key = retainKey(request.name);
      const existing = await this.store.get(key);
      if (existing !== undefined && decodeValue(existing) !== request.commit)
        throw new TypeError(`Retention already exists: ${request.name}`);
      await this.publish([put(key, request.commit)]);
    });
  }

  releaseRetention(name: string): Promise<void> {
    return this.enqueue(async () => {
      const key = retainKey(name);
      if ((await this.store.get(key)) === undefined)
        throw new TypeError(`Unknown retention: ${name}`);
      await this.publish([{ type: "delete", key }]);
    });
  }

  async collectGarbage(): Promise<GarbageCollectionReport> {
    this.assertOpen();
    throw new Error(
      "Incremental key-value garbage collection is not implemented yet (step 3)",
    );
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.queue;
      this.closed = true;
      for (const subscriber of this.subscribers) subscriber.wake?.();
      this.tree.dispose();
      await this.store.close();
    })());
  }

  private async publish(
    operations: readonly KeyValueOperation[],
    retention = this.metadata.retention,
  ): Promise<void> {
    const next: Metadata = {
      ...this.metadata,
      nextPageId: this.pages.nextId,
      revision: this.metadata.revision + 1,
      retention,
    };
    const bytes = encodeValue(next);
    try {
      await this.store.batch(
        [...operations, { type: "put", key: metadataKey, value: bytes }],
        [{ key: metadataKey, expected: this.metadataBytes }],
      );
    } catch (error) {
      // A backend error can occur after durable publication. Never continue
      // from stale in-memory roots after an ambiguous outcome or a stale writer.
      this.failed = true;
      throw error;
    }
    this.metadata = next;
    this.metadataBytes = bytes;
  }

  private async readCommit(id: string): Promise<StoredCommit> {
    const value = await this.store.get(commitKey(id));
    if (value === undefined) throw new HistoryUnavailableError(id);
    const commit = decodeValue(value) as StoredCommit;
    if (commit.id !== id || commit.manifest.schema !== this.metadata.schema)
      throw new Error("Invalid commit or schema in key-value storage");
    return commit;
  }

  private branch(name: string): Branch {
    const branch = this.branches.get(name);
    if (!branch) throw new TypeError(`Unknown branch: ${name}`);
    return branch;
  }

  private toBatch(commit: StoredCommit): CommitBatch {
    return Object.freeze({
      commit: commit.id!,
      branch: commit.branch,
      sequence: commit.sequence,
      version: commit.sequence,
      parent: commit.parent!,
      changes: Object.freeze(
        commit.changes.map((change) => {
          const table = this.tables.get(change.table)?.table;
          if (!table) throw new TypeError(`Unknown table: ${change.table}`);
          return Object.freeze({
            ...change,
            table,
            key: Object.freeze([...change.key]),
            ...(change.before === undefined
              ? {}
              : { before: Object.freeze(change.before) }),
            ...(change.after === undefined
              ? {}
              : { after: Object.freeze(change.after) }),
          });
        }),
      ),
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.queue.then(() => {
      if (this.failed)
        throw new Error(
          "Key-value storage requires reopening after a publication failure",
        );
      return operation();
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed || this.closing || this.failed)
      throw new Error("Key-value storage is closed or requires reopening");
  }
}

export const openKeyValueStorage = (
  options: KeyValueStorageOptions,
): Promise<KeyValueStorageDatabase> => KeyValueStorageDatabase.open(options);
