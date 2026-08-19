# HyDB

## Seed

Build a JavaScript database engine for Node.js that lets applications define schemas and trusted transactors once, execute those transactors optimistically on clients and authoritatively on the backend, and keep relational queries live through incremental differential-dataflow-style updates.

## Solution

- Runtime: one isomorphic JavaScript engine runs in browsers, workers, and Node.js; adapters supply persistence, scheduling, and transport.
- Schema: versioned definitions establish tables, types, primary/foreign keys, indexes, defaults, and migrations for both client and server.
- Transactors: a versioned named registry is bundled to both ends; clients submit only a name and validated arguments, while the server alone authorizes, executes, and commits.
- Reconciliation: each client maintains an ordered provisional overlay, then removes, rejects, and deterministically rebases pending transactors over authoritative commits.
- Query API: frontend-built declarative queries compile to a canonical, serializable plan supporting parameters, filters, projection, joins, grouping, aggregates, ordering, and limits—never arbitrary client code.
- Query placement: the same plan can materialize immediately over a frontend cache, authoritatively on the backend, or in hybrid mode where local results are reconciled with server result deltas.
- Dataflow: collections carry integer-weighted `(row, commitVersion, diff)` updates through incremental operators; shared keyed arrangements power joins and maintained views, including incremental top-k for ordered limits.
- Ordering: the first release uses one authoritative commit sequencer and scalar progress frontier; recursive queries, partial-order timestamps, and distributed execution are deferred.
- Storage and sync: the backend owns an append-only commit log plus snapshots; a resumable WebSocket protocol carries query plans, snapshots, weighted deltas, mutation acknowledgements/rejections, and progress frontiers.
- Trust boundary: the backend authenticates clients, validates schema/transactor versions, and rewrites or rejects queries under server-defined read policies before any data is exposed.
