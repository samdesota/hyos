# Key-value storage prototype (step 2)

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

`KeyValueStore` exposes `get`, `getMany`, prefix `scan`, conditional atomic
`batch`, and `close`. Values are owned byte arrays; keys are UTF-8 strings up to
480 bytes. Scans have snapshot semantics; finish or return iterators promptly.
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

One active writer instance is supported. An atomic metadata comparison rejects a
stale writer before it overwrites pages; it does not refresh other instances or
provide distributed subscriptions. A publication failure requires closing and
reopening: an I/O error can leave the outcome uncertain. Validation errors before
publication leave the previous head intact and allow another transaction.

## Prototype boundaries

- No migration from file databases and no schema migration support yet. Reopening
  requires the same schema.
- Retention policy and named roots are persisted, but nothing is deleted yet.
  `collectGarbage()` explicitly throws until step 3 adds incremental reclamation.
- LMDB can reuse deleted pages once readers release them; this does not imply
  immediate filesystem shrinkage. Disk shrinkage is a separate concern.
- A write stages all new pages in memory and publishes one transaction. Large
  transactions and synchronous cold LMDB reads need measurement in step 4.
- No default-app switch or performance claim is part of this step.

## Verification

`npm test --workspace @hyos/hydb` includes adapter contract tests, cross-engine
behavior, failure injection, stale-writer protection and process-exit durability.
Native LMDB needs an environment that permits its memory mapping and locking.
On macOS, the restricted agent sandbox aborts in LMDB open; tests must run outside
that sandbox against temporary directories.

After building, Electron compatibility can be checked without launching the app:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test packages/hydb/dist/test/key-value-runtime.test.js
```

The process-exit test verifies acknowledgement without graceful close; it does
not simulate a machine power failure.
