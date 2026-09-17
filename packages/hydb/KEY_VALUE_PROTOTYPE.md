# Key-value storage prototype (steps 2–3)

The opt-in engine uses HyDB's existing immutable B+ trees, row/index mutation
logic and snapshot reader. The default persistent backend is LMDB (`lmdb@3.5.6`).
The existing app and `openNodeStorage` continue using the file engine.

```ts
import { openKeyValueStorage, memoryKeyValueStore } from "@hyos/hydb/node";

// A new, separate database directory. Do not point at existing app data.
const storage = await openKeyValueStorage({
  schema,
  directory: "./scratch-kv",
});
const db = await hydb.database({ schema, storage });
// Existing query / transaction APIs work through the StorageDatabase interface.
await db.close();

// Same engine, replaceable binary KV backend (owned/closed by the engine).
const testStorage = await openKeyValueStorage({
  schema,
  store: memoryKeyValueStore(),
});
await testStorage.close();
```

## Backend contract

`KeyValueStore` exposes `get`, `getMany`, prefix `scan` and `scanKeys`, conditional atomic
`batch`, and `close`. Values are owned byte arrays; keys are UTF-8 strings up to
480 bytes. Scans have snapshot semantics and support an exclusive `after` cursor
and a `limit`; finish or return iterators promptly.
`getMany` preserves order but does not guarantee one snapshot across all keys.
Persistent batch success means durable completion. Implementations must check
conditions and apply every edit in one transaction. A cloud adapter must supply
these semantics; merely mapping methods to independent remote requests is unsafe.

Pages, commits, branch heads, branch sequence history, named retention roots and
format metadata have separate key namespaces. New pages remain private to the
writer until one atomic batch publishes them alongside the commit and branch
head. Readers use immutable page IDs. Public heads and change notifications
advance only after durable acknowledgement. LMDB uses conservative sync settings
and explicitly awaits `flushed`.

Use one active storage instance per database when running GC: reader pins are
process-local, so other instances/processes must be closed first. An atomic metadata comparison rejects a
stale writer before it overwrites pages; it does not refresh other instances or
provide distributed subscriptions. A publication failure requires closing and
reopening: an I/O error can leave the outcome uncertain. Validation errors before
publication leave the previous head intact and allow another transaction.

## Incremental reclamation

Call `await storage.collectGarbage()` explicitly. No background timer or app
integration is enabled. `gcBatchSize` (default 128, range 1–4096) limits records
processed per slice. The collector yields to the event loop between slices.

1. Capture the retention horizon and next page ID in the writer queue.
2. Prune expired commits/history in short atomic batches. Preserve branch heads
   and bases, named retains, open snapshots, unread change-stream history, and
   commits retained by count or age. Advance branch history floors atomically;
   stale change cursors report `HistoryUnavailableError`.
3. Mark pages reachable from surviving commits, yielding during traversal.
4. Delete unmarked pages below the captured page-ID cutoff in bounded batches.
   Concurrent writes use newer IDs and can share the protected older pages.

Readers can open surviving commits throughout collection. An admission barrier
rejects new pins on commits whose deletion has already begun. Each deletion
batch briefly uses the normal writer queue; marking and scans do not hold it.
Scan cursors close between slices, avoiding a long-lived native LMDB reader.
Simultaneous collection calls share one cycle. Closing cancels at the next slice
boundary and drains accepted writes. On interruption, reopen and call GC again;
it recomputes reachability and safely handles any completed deletion batches.

This is **incremental scheduling**, not a constant-work collector: each cycle
still scans commits/pages and keeps an in-memory set of live page IDs. The batch
limit bounds record counts, not strict milliseconds or bytes; unusually large
records can still take longer. The memory adapter sorts its map for bounded
scans; LMDB seeks directly. See the benchmark results for measured costs.

The report's `pagesCollected` and `commitsCollected` count deleted records.
`recordsCopied` is zero. Byte fields count observed logical page/commit payloads
and exclude history, metadata, keys and LMDB overhead; they are not a filesystem
size measurement. Concurrent inserts can affect the observed totals.

## Prototype boundaries

- No migration from file databases and no schema migration support yet. Reopening
  requires the same schema.
- LMDB can reuse deleted pages once readers release them; this does not imply
  immediate filesystem shrinkage. Disk shrinkage is a separate concern.
- A write stages its reachable new pages in memory and publishes one transaction.
  Arbitrarily large transactions and synchronous cold LMDB reads remain unbounded.
- No default-app switch or performance claim is part of this step.

## Verification

`npm test --workspace @hyos/hydb` includes adapter contract tests, cross-engine
behavior, failure injection, reader/retention protection, concurrent writes during
GC, stale-writer protection and process-exit recovery (including during a sweep).
Native LMDB needs an environment that permits its memory mapping and locking.
On macOS, the restricted agent sandbox aborts in LMDB open; tests must run outside
that sandbox against temporary directories.

After building, Electron compatibility can be checked without launching the app:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test packages/hydb/dist/test/key-value-runtime.test.js
```

The process-exit test verifies acknowledgement without graceful close; it does
not simulate a machine power failure.

## Memory amplification controls

After each complete row mutation, staging traces the current primary/index
roots and drops superseded unpublished pages. Shared children remain live;
published pages and snapshot roots are immutable and unaffected. Publication
still commits the entire transaction atomically. Tree serialization transfers
ownership internally, while public writes copy their inputs and reads return
independent buffers.

Each new page has an eight-byte `page-size/<id>` sidecar, published and deleted
atomically with its page. GC sweeps keys and reads these tiny size values,
avoiding dead page payloads. Legacy databases without sidecars remain readable
and collectable: reports set `accountingComplete: false`, count
`pagesWithoutSize`, and report byte totals as lower bounds. Logical byte totals
exclude sidecars, history entries, metadata, key bytes, and LMDB overhead.
