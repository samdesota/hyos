# Persistent immutable storage trees for HyDB

Status: design research, not an implementation specification

## Recommendation

Build the first Node.js persistent backend around an **append-only page store, immutable copy-on-write B+ trees, and a commit DAG whose manifests contain every table and index root**.

Do **not** make a Hitchhiker Tree the v1 foundation. Its buffered operations are an attractive later optimization for write amplification, but they complicate point reads, range scans, mutation ordering, compaction, and tree diffing before HyDB has a measured write bottleneck. The important property for the product goal is immutable, retained roots; Hitchhiker buffering is not required for branching or historical reads.

Use content hashes for commit and manifest identity from the beginning. Node pages may initially use immutable physical addresses (segment plus offset), provided their format can later accept content-addressed references. If efficient cross-branch diff, merge, and replication becomes a near-term product requirement, promote page identity to content hashes and evaluate a history-independent prolly tree in phase 3.

This separates three concerns which are easy to conflate:

1. **Snapshots and branches:** immutable nodes plus retained root pointers.
2. **Durability:** append records children-first, then atomically publish a branch head after a durable flush.
3. **Efficient semantic diff/merge:** content-addressing helps; history-independent tree shape (as in prolly trees) helps substantially more.

## Requirements and invariants

The storage engine should satisfy these invariants:

- Opening a snapshot pins one immutable commit. Its reads never observe later commits.
- A commit names all primary and secondary index roots as one atomic database value.
- A branch is a small mutable ref to a commit. Creating `feature` from commit `C` writes only a ref, so it is O(1) in database size.
- An update never overwrites a page reachable from a retained commit.
- A historical query uses the exact primary and secondary index roots recorded by that historical commit; indexes are not rebuilt from current data.
- Queries traverse only needed disk pages through a bounded cache. Database size must not determine process heap size.
- A branch commit is compare-and-swap on its expected head. One writer is enough for v1; snapshots and readers can be concurrent.
- Garbage collection may reclaim an object only if it is unreachable from every branch/tag, open snapshot pin, in-progress writer, and retention-policy root.

## What the candidate structures provide

### Hitchhiker Tree

The linked implementation describes a functional, persistent, serializable, lazily loaded sorted key-value tree with a pluggable backing-store protocol. Its stated design combines a B+ tree with bounded operation logs in internal nodes: most updates append an insert/delete message to the root; overflowing messages are pushed toward their destination; a lookup applies relevant messages along its root-to-leaf path. Path copying then often persists only the changed root rather than a complete root-to-leaf path. It supplies point lookup and forward iteration, and its sample Outboard API forks a tree by saving a snapshot under another name ([repository README](https://github.com/datacrypt-project/hitchhiker-tree), [design document](https://github.com/datacrypt-project/hitchhiker-tree/blob/master/doc/hitchhiker.adoc)).

That is a good match for immutable snapshots, lazy loading, and write-heavy workloads. A more recent independent implementation, Noblit, likewise uses immutable 4 KiB nodes, stores pending datoms in internal nodes, and reclaims unreachable nodes by copying live nodes to a new file ([Noblit tree format](https://docs.ruuda.nl/noblit/htree/)).

The costs matter for HyDB:

- Every point read must resolve all pending operations on its path. A range iterator must merge leaf contents with relevant messages from every traversed ancestor.
- Deletes, repeated updates, secondary indexes, and transaction-local read-your-writes all need precisely defined message composition.
- The tree is persistent, but not necessarily history-independent: equivalent logical states reached by different write histories can have different pending buffers and shapes. Structural sharing makes related-branch diffs better than full scans in favorable cases, but it does not provide prolly-tree-style canonical chunk boundaries.
- The linked reference implementation is Clojure/EPL-1.0 prior art, not a Node.js storage dependency. Its repository is not archived, but its most recent pushed commit is dated July 2018; its durable example is Redis-backed ([repository metadata and source](https://github.com/datacrypt-project/hitchhiker-tree)). Its ideas are useful, but HyDB would still be implementing and validating a new disk format, crash protocol, garbage collector, and TypeScript read path.

**Conclusion:** retain Hitchhiker Tree as an optimization candidate after a correct immutable B+ tree establishes workload measurements. The cleanest migration is to preserve the same page-store and tree-cursor interfaces, then allow internal nodes to contain ordered mutation messages.

### Immutable copy-on-write B/B+ tree

An update copies the leaf and ancestors on the changed path, sharing every untouched subtree with the prior root. With a high fanout, both point lookup and update touch a small number of pages; leaves provide natural ordered and range scans. A new database snapshot is one new manifest/root reference, and old roots remain queryable as long as their pages remain retained.

LMDB demonstrates the core concurrency properties: its data pages use copy-on-write, it is multi-versioned, readers do not lock, writes are serialized, and it reuses pages no longer visible to readers ([LMDB public header and architecture comments](https://github.com/openldap/openldap/blob/master/libraries/liblmdb/lmdb.h)). LMDB itself is not the complete answer for HyDB branches: ordinary MVCC protects active readers, not an arbitrary user-visible commit DAG, and page reuse would destroy old states unless every branch root participates in retention.

The main trade-off is write amplification: a random update writes roughly one page at each tree level, and rebalancing can write siblings. That is much simpler than buffered trees and usually acceptable for a first engine with batched transaction application. Related versions share unchanged physical pages, although history-dependent splits mean logically equal trees need not have equal layouts.

**Fit:** strongest v1 choice. It is the smallest structure that directly provides point lookup, prefix/range scans, immutable snapshots, cheap branches, and bounded memory.

### Append-only B-tree and MVCC

Append-only is a storage discipline rather than a different search structure. CouchDB uses B-trees for documents and indexes, appends index updates at the end of the file, gives readers a consistent MVCC snapshot, and commits by first synchronously flushing data/index updates and then writing and flushing redundant database headers ([technical overview](https://docs.couchdb.org/en/stable/intro/overview.html)). Its B-tree views support efficient key lookup and streaming key ranges with a small memory footprint ([views documentation](https://docs.couchdb.org/en/stable/ddocs/views/intro.html)).

This is a strong crash-safety model for HyDB. The cost is garbage: obsolete nodes accumulate and compaction rewrites the live database into another file, temporarily requiring roughly twice the space ([CouchDB compaction](https://docs.couchdb.org/en/stable/maintenance/compaction.html)). CouchDB also explicitly does not promise to retain old document versions indefinitely ([revision API discussion](https://docs.couchdb.org/en/latest/intro/api.html)); HyDB must make branch heads, tags, and historical-retention policy first-class GC roots rather than inheriting that lifecycle.

**Fit:** use an append-only record/page store and CouchDB-like publish ordering under the immutable B+ tree.

### Content-addressed Merkle and prolly trees

Git shows the basic persistent object model: immutable objects have content-derived IDs; commits point to snapshot trees and parent commits; branch names are lightweight movable commit pointers ([Git data model](https://git-scm.com/docs/gitdatamodel), [branches](https://git-scm.com/book/en/v2/Git-Branching-Branches-in-a-Nutshell)). A HyDB commit DAG should use this model even if the first index pages use physical immutable IDs.

Git's directory tree is not a sorted database index. Prolly trees add that capability. Noms defines a prolly tree as a sorted probabilistic B-tree whose content-defined chunk boundaries make representation history-independent: the same logical value has the same chunk graph regardless of mutation order. That allows equal-hash subtrees to be skipped during diff, sync, and merge while retaining logarithmic search and efficient ordered scans. Its design estimates about one rewritten chunk per level for a small mutation ([Noms design](https://github.com/attic-labs/noms/blob/master/doc/intro.md)). Dolt explains the key distinction from an ordinary B-tree: nodes refer to children by content address, and deterministic local chunk boundaries remain stable around edits, maximizing structural sharing ([Dolt prolly chunking](https://www.dolthub.com/blog/2022-06-27-prolly-chunker/)). Dolt uses one prolly tree per table and per index, writing copy-on-write chunks into an append-only chunk store ([Dolt GC design](https://www.dolthub.com/blog/2025-03-21-session-aware-gc-technical-details/)).

Costs relative to a fixed-page B+ tree include rolling/content hashing CPU, variable node sizes, more complex mutation code, and less predictable I/O. Dolt notes that chunk-size variance can make disk I/O unpredictable and that each copy-on-write chunk must be copied before mutation ([Dolt chunker analysis](https://www.dolthub.com/blog/2022-06-27-prolly-chunker/)). Content addressing also requires a scalable hash-to-location index; keeping that entire index in a JavaScript `Map` would violate the larger-than-RAM requirement.

**Fit:** best eventual choice if efficient database diff/merge/replication is central. It is not necessary merely to create branches or query historical indexes. Prototype it after the page store and correctness model stabilize.

### LSM trees

LSM engines buffer writes and flush immutable sorted runs, then compact them. They excel at sustained write throughput, but reads may consult several runs and range scans merge iterators across them. RocksDB documents the fundamental choice: leveled compaction minimizes space amplification at the cost of read/write amplification, while tiered compaction lowers write amplification but increases read and space amplification ([RocksDB compaction](https://github.com/facebook/rocksdb/wiki/Compaction), [tuning definitions](https://github.com/facebook/rocksdb/wiki/RocksDB-Tuning-Guide)).

Snapshots based on sequence numbers are straightforward within one linear engine history, but arbitrary long-lived branch manifests make compaction ownership and version retention substantially harder: a run obsolete on one branch can remain live on another, and branch-local compactions create large new manifests and duplicate data. An immutable-SST manifest DAG can be designed, but it moves HyDB's hardest problem into compaction and multi-run historical reads.

**Fit:** not v1. Reconsider for high ingest rates after branch-aware compaction and historical retention are specified.

## Comparison

| Structure             | Point/range reads                                | Small update                               | Cheap retained roots               | Branch diff/merge                                     | Main operational cost                              |
| --------------------- | ------------------------------------------------ | ------------------------------------------ | ---------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| Immutable COW B+ tree | Excellent; predictable page traversal            | About one page per level                   | Yes                                | Good for structurally shared relatives; not canonical | Path-copy write amplification                      |
| Hitchhiker Tree       | Good, but reads apply buffered messages          | Usually root-only; periodic flush cascades | Yes                                | History-dependent buffers weaken semantic diff        | Complex read/flush/GC correctness                  |
| Prolly tree           | Good; variable chunk sizes                       | About one chunk per level in expectation   | Yes                                | Excellent; canonical content-addressed subtrees       | Hashing, chunk variance, implementation complexity |
| LSM                   | Point reads need filters; range scans merge runs | Excellent append/flush path                | Possible, but retention is awkward | Manifests can branch; compaction makes it costly      | Background compaction and amplification trade-offs |

## Proposed on-disk architecture

### Logical object graph

```text
branch ref -> commit
                |-- parent commit(s)
                |-- schema/catalog object
                |-- durable change batch
                `-- database manifest
                      |-- table A primary root
                      |-- table A index roots...
                      |-- table B primary root
                      `-- table B index roots...
```

A primary tree key is the encoded primary-key tuple. Its leaf value is the serialized row, or a reference to an overflow value object. A secondary tree key should be `(encoded index columns, encoded primary key)`; including the primary key makes non-unique indexes naturally ordered and avoids mutable buckets. Unique-index validation scans the exact encoded prefix before commit. Optional covering columns can be added later without changing the tree abstraction.

Each commit should contain at least:

```ts
type CommitId = string;
type ObjectId = string;

type CommitManifest = Readonly<{
  parents: readonly CommitId[];
  databaseRoot: ObjectId;
  changes: ObjectId;
  schema: ObjectId;
  logicalTime: bigint;
}>;
```

The commit ID should hash a canonical serialization of the manifest. A merge commit can have two parents. Branch creation writes `refs/heads/name -> commitId`; it does not walk or copy a table.

### Page and segment store

Start with immutable 16-32 KiB B+ tree pages to amortize JavaScript/native-call overhead while keeping cache entries reasonably small; tune the size by benchmark rather than treating 4 KiB as axiomatic. Store records in an append-only active segment. Every record needs a length, format version, type, object/page ID, payload, and checksum so recovery can reject a torn tail.

Do not keep the entire block location index in the V8 heap. A workable staged layout is:

- one bounded active segment with an in-memory ID-to-offset map;
- sealed segments with a sorted on-disk ID-to-offset footer (plus an optional bounded Bloom filter);
- positioned reads and binary search of sealed indexes;
- a byte-budgeted LRU page cache containing decoded immutable pages;
- background compaction which copies objects reachable from the current root set into new segments, then atomically installs the new segment set.

For an initial physical page ID, the location is direct `(segmentId, offset)`. For content-addressed pages, the sealed segment footer is the hash-to-location index. The latter enables deduplication and stronger diff/sync semantics but is not required for branch correctness.

Node exposes positioned `FileHandle.read`, `write`/`writev`, `datasync`, and `sync`; its documentation warns that overlapping writes on one handle are unsafe, which reinforces a serialized writer queue. `sync()` requests flushing file data to storage ([Node.js file system API](https://nodejs.org/api/fs.html)). Use async I/O on the writer and cache miss path. Compression, checksumming, and content hashing are CPU work and can move to a small worker pool only after profiling; Node's worker guidance says workers help CPU-intensive work, not I/O ([Node.js worker threads](https://nodejs.org/api/worker_threads.html)).

### Crash-safe commit protocol

For one append journal in v1:

1. Compare the requested branch's current head with `expectedHead`; reject on mismatch.
2. Apply the transaction to the parent roots, writing new/changed leaf pages and then ancestors. Never overwrite a reachable page.
3. Write the new table/index root manifest, durable change batch, and commit object.
4. Append a checksummed branch-ref record `(branch, oldHead, newHead)` last.
5. Call `FileHandle.sync()` once for the complete append and only then publish the new head to readers/listeners.

On recovery, scan from the last sealed/checkpoint boundary and accept only complete checksummed records. The last valid ref update is the branch head; a torn tail is ignored. If refs live in a separate file, follow the stricter CouchDB ordering: sync all referenced objects first, then write and sync redundant/double-buffered ref metadata. Never publish a ref before its dependency objects are durable; Dolt's discussion of a root record written before its referenced chunks are synced illustrates the resulting durability bug ([DoltLite review](https://www.dolthub.com/blog/2026-04-08-doltlite-code-review-highlights/)).

### Garbage collection and compaction

Roots are:

- all branch and tag heads;
- commits retained by time/count policy;
- explicitly pinned historical commits;
- every open snapshot lease;
- objects being built by active writers;
- the active compaction generation until cutover completes.

Mark reachable commits, manifests, tree pages, and overflow values, then copy live objects to new sealed segments. Install the new segment-generation manifest durably before deleting old segments. Long-lived snapshots delay reclamation, so snapshot objects need explicit `close()` plus observable lease/pin accounting. The copying model is shared by immutable systems such as Noblit and CouchDB, and Dolt's GC design demonstrates why in-progress writers must also protect newly written, not-yet-rooted chunks ([Noblit](https://docs.ruuda.nl/noblit/htree/), [CouchDB](https://docs.couchdb.org/en/stable/maintenance/compaction.html), [Dolt](https://www.dolthub.com/blog/2025-03-21-session-aware-gc-technical-details/)).

## Changes required in HyDB

### Storage interface

The current `CommitVersion = number` and parameterless `snapshot()` encode one linear history. Replace the public storage identity with commit and branch concepts. Keep **two deliberately separate clocks**:

- `CommitId` is immutable DAG identity. It selects historical state, names parents, and is valid across branches.
- `BranchSequence` is a monotonically increasing delivery timestamp for one branch's change stream. DDF uses it to order incremental batches; it does not identify database state globally.

This prevents a merge commit or two sibling commits from being forced into one misleading scalar version order.

An illustrative direction:

```ts
type CommitId = string;
type BranchName = string;
type BranchSequence = bigint;

type SnapshotSelector =
  { readonly branch: BranchName } | { readonly commit: CommitId };

interface StorageSnapshot {
  readonly commit: CommitId;
  get(table: AnyTable, key: StorageKey): Promise<StoredRow | undefined>;
  scan(request: StorageRangeScan): AsyncIterable<readonly StoredRow[]>;
  close(): Promise<void>;
}

interface StorageDatabase {
  snapshot(at: SnapshotSelector): Promise<StorageSnapshot>;
  commit(request: {
    branch: BranchName;
    expectedHead: CommitId;
    mutations: readonly StorageMutation[];
  }): Promise<CommitBatch>;
  createBranch(request: { name: BranchName; from: CommitId }): Promise<void>;
  changes(options: {
    branch: BranchName;
    after: BranchSequence;
    signal?: AbortSignal;
  }): AsyncIterable<CommitBatch>;
  diff?(from: CommitId, to: CommitId): AsyncIterable<CommittedChange>;
  close(): Promise<void>;
}
```

`StorageScan` currently supports either a full table scan or one exact index key. It needs an ordered key range (`gt/gte/lt/lte`), direction, optional limit, requested columns/covering payload, and batch-size hint. The storage layer—not `QueryDatabase`—must own key encoding and index-root selection for a snapshot.

Each branch change record should carry both `{ commit: CommitId, sequence: BranchSequence }`. Define branch movement semantics for `changes`: v1 should permit only fast-forward commits through `commit()`. Branch reset/delete can either be rejected while listeners exist or produce an explicit `reset` event. A DDF graph cannot interpret an arbitrary ref jump as the next scalar timestamp without either a stored root diff or a complete re-bootstrap.

### Query and DDF runtime

Persistent storage alone will not make HyDB larger than memory. Today `database()` opens a snapshot and copies every row of every table into JavaScript `Map`s; `QueryDatabase.rows()` and `lookup()` read those maps; subscriptions initialize `DifferentialQuery` from the fully hydrated tables. That architecture must change.

The query plan should consume asynchronous storage cursors:

- push primary-key and secondary-index predicates into `get`/range scans;
- stream decoded batches through filter/project/order/limit operators;
- keep only a byte-bounded page cache and query working set;
- bootstrap each DDF source from a snapshot scan, then advance it from that branch's persisted change batches;
- materialize only arrangements required by active subscriptions, and later add spillable/storage-backed traces for arrangements that exceed a memory budget.

Some real-time queries inherently materialize large state (for example, an unbounded join or full sorted result). The engine can guarantee that **the database** is not resident, but bounded memory for every possible query requires spill policies and query limits in addition to a disk tree.

Historical `fetch` opens a snapshot at the requested commit and plans against that commit's catalog/index roots. Historical `subscribe` should initially be disallowed or defined as subscribing to a branch starting from a selected ancestor; a fixed historical commit has no future changes of its own.

## Staged delivery

### Phase 1: durable immutable B+ tree

- Append-only segment/page store with checksums and recovery from torn tails.
- Immutable B+ tree `get`, range cursor, batched insert/update/delete, split/merge, and root return.
- Commit manifest/DAG and branch refs with expected-head compare-and-swap.
- Primary and secondary root updates in one atomic commit.
- Snapshot pins, historical reads, and stop-the-world copying compaction.
- Fault-injection tests at every record boundary and every commit-publish boundary.

### Phase 2: bounded-memory query integration

- Async range-source operators and predicate/index pushdown.
- Byte-budgeted decoded page cache with hit/miss/eviction metrics.
- Per-branch durable change streams and DDF bootstrap without global table hydration.
- Snapshot/GC lease accounting and background generation compaction.

### Phase 3: version-control acceleration

- Tree-level diff that skips identical/shared page IDs.
- Three-way merge over primary and index trees, with conflicts expressed at logical row/field level rather than page level.
- Benchmark history-dependent COW pages against content-addressed prolly chunks for realistic HyDB rows, branch divergence, diff, merge, and replication.
- Only then choose between content-addressed COW B+ pages, prolly trees, or a mixed model.

### Phase 4: write-path optimization if measurements justify it

- Prototype bounded operation buffers in immutable internal nodes behind the same cursor/page-store seam.
- Compare write amplification, p50/p99 point reads, range scans, cache churn, and compaction load against batched COW B+ updates.
- Adopt Hitchhiker-style buffering only if the write gain outweighs read-path and correctness complexity.

## Validation matrix

Before treating the backend as durable, test:

- reopening after truncation at every byte/record boundary of a commit;
- failure before and after `sync()` and before in-process head publication;
- branch creation at every retained commit and independent commits on both descendants;
- exact historical primary and secondary-index reads before/after updates and deletes;
- scans crossing leaf splits/merges in both directions and at every open/closed bound;
- unique-index conflicts within one batch and against the parent snapshot;
- a database much larger than the page-cache budget with stable heap use;
- snapshot pins held across compaction, then released and reclaimed;
- branch deletion while other branches share most pages;
- differential subscriptions across commits, process restart, and change-log catch-up;
- randomized model comparison against the in-memory backend.

## Decision summary

The v1 foundation should be **immutable COW B+ indexes over a crash-safe append-only page store, wrapped in a Git-like commit/branch object model**. This directly meets the current requirements and creates the right deep seam: tree algorithms depend on an immutable page resolver/writer, while query execution depends on ordered snapshot cursors and branch change streams.

Hitchhiker Trees remain valuable research, specifically as a write-optimized tree implementation behind that seam. Prolly trees are the stronger candidate when canonical structure, fast cross-branch diff/merge, and replication become requirements. Neither optimization should delay the simpler durability, historical-root, bounded-cache, and query-cursor architecture that both would need anyway.
