# Spillable sort and join operators for HyDB

Status: design research, not an implementation specification

## Recommendation

Implement two related but distinct execution paths:

1. Finite `fetch()` queries should use conventional bounded-memory batch operators: external merge sort, indexed nested-loop join, adaptive hash/Grace hash join, and sort-merge join.
2. Live queries should use persistent ordered and keyed arrangements that can move cold immutable batches to disk. Re-running a batch spill algorithm on every commit would discard the main benefit of differential execution.

Both paths should share one database-level memory manager and one query-owned spill store. Memory must be budgeted by bytes, not row counts, and disk spill must have an explicit limit. This follows the useful separation in DataFusion, where memory-consuming operators acquire reservations from a global memory pool and memory-limited queries spill intermediate state; its configuration also reserves merge memory and bounds merge fan-in ([DataFusion runtime configuration](https://github.com/apache/datafusion/blob/main/docs/source/user-guide/configs.md)). DuckDB independently exposes both a memory limit and a maximum temporary-directory size, and fails the query when spilling is unavailable or the disk budget is exhausted ([DuckDB memory management](https://duckdb.org/2024/07/09/memory-management)).

The first implementation should be deliberately conservative: one asynchronous query pipeline at a time per subscription, sequential spill I/O, deterministic ordering, checksummed files, and cleanup tied to query lifetime. Parallel partitions can follow once invariants and telemetry are established.

## Current HyDB constraints

At commit `4249353`, [`packages/hydb/src/dataflow.ts`](../../packages/hydb/src/dataflow.ts) is entirely synchronous:

- `Change.diff` is only `1 | -1`; `ChangeHandler` and `Stream.emit()` return `void`.
- `ArrangeOperator` retains every record in a `Map` and every key bucket in a `Set`.
- `JoinOperator` subscribes symmetrically to both arrangements and probes the other side immediately.
- `OrderTopKOperator` retains all records and re-sorts every affected group after each batch.
- `DifferentialQuery.apply()` calls `begin()`, `compiler.apply()`, and `flush()` without an asynchronous settlement boundary.

Consequently, simply making an arrangement lookup asynchronous would be incorrect: `Stream.emit()` would not wait for it, and `OutputOperator.flush()` could publish before disk-backed descendants finished. The runtime change described below is a prerequisite for spillable live operators. Finite `fetch()` evaluation can adopt asynchronous batch operators independently and earlier.

## Shared resource layer

### Memory manager

Use a global hard limit subdivided into revocable reservations:

```ts
interface MemoryManager {
  reserve(owner: string, minimumBytes: number): MemoryReservation;
  readonly usedBytes: number;
  readonly limitBytes: number;
}

interface MemoryReservation {
  tryGrow(bytes: number): boolean;
  shrink(bytes: number): void;
  release(): void;
  onReclaim(requestedBytes: number): Promise<number>;
}
```

Each allocation is charged before it is retained. A failed `tryGrow` asks revocable consumers to spill or evict, then retries; failure after reclamation becomes a query resource error. Give every spillable operator a non-revocable minimum sufficient to make progress: encoder buffers, one output block, and merge input buffers. Without that floor, a full pool can prevent the operation needed to release memory. DataFusion exposes this exact concern as a per-sort spill reservation for the in-memory sort/merge work required during spilling ([configuration source](https://github.com/apache/datafusion/blob/main/docs/source/user-guide/configs.md#datafusionexecution-sort-spill-reservation-bytes)).

The B+ page cache should participate as a revocable consumer, but operator working state gets progress guarantees. Under ordinary pressure, first spill oversized operators and evict cold decoded pages; under severe process pressure, also shrink raw-page buffers. Runtime RSS/heap sampling may lower the effective limit, but explicit accounting remains authoritative.

Track separately:

- retained row payload bytes;
- hash/sort/index metadata estimates;
- input/output and merge buffers;
- raw page buffers and decoded page estimates;
- spill bytes, read/write bytes, run/partition count, and spill/repartition time.

### Spill store

Spill state is derived and transient, never part of the durable database segments:

```ts
interface SpillStore {
  createRun(kind: "sort" | "hash" | "arrangement"): Promise<RunWriter>;
  openRun(id: RunId): Promise<RunReader>;
  removeRun(id: RunId): Promise<void>;
  readonly usedBytes: bigint;
  readonly limitBytes: bigint;
  close(): Promise<void>;
}
```

Use a private directory per process and a subdirectory per query. Files should contain versioned, length-delimited blocks with checksums, row counts, and optional compression; sorted and arrangement runs also record min/max keys and sparse block offsets. Sequential I/O is the default. The final merge may be streamed directly rather than materialized, an optimization PostgreSQL uses to avoid a complete extra write/read cycle ([PostgreSQL `tuplesort.c`](https://github.com/postgres/postgres/blob/master/src/backend/utils/sort/tuplesort.c)).

All runs are registered before use. Normal completion, cancellation, iterator early-return, subscription disposal, and database close must close readers and remove the query directory in `finally`. On startup, HyDB may scavenge directories whose owner lock/lease is stale. Never reuse a spill file across queries or treat it as recovery state. PostgreSQL likewise closes its temporary logical tape set when a sort is freed ([PostgreSQL `tuplesort_free`](https://github.com/postgres/postgres/blob/master/src/backend/utils/sort/tuplesort.c#L818)).

Enforce both per-query and database-wide temporary byte budgets. Crossing a limit cancels the query with its measured memory/disk usage; it must not silently consume the database volume.

## Finite spillable sort

Use external merge sort:

1. Accumulate encoded rows until the reservation cannot grow.
2. Sort the batch in memory and write one immutable sorted run.
3. Release row memory and continue.
4. At end of input, sort the remainder.
5. Merge runs with a min-heap containing the current row from each run, reading bounded blocks sequentially. If all runs cannot be opened/buffered within the reservation or file-descriptor limit, merge them in multiple bounded-fan-in passes.

This is the established shape of PostgreSQL's implementation: small inputs remain in memory; large inputs become sorted temporary runs; a balanced k-way merge holds the front tuple from each source and pre-reads bounded blocks for sequential locality ([PostgreSQL `tuplesort.c`](https://github.com/postgres/postgres/blob/master/src/backend/utils/sort/tuplesort.c)).

The physical sort key must append a stable row identity after the SQL/query order keys:

```text
(order-expression-1, ..., order-expression-n, stable-row-id)
```

All run generation, merging, and in-memory sorting must use the same total comparator, including null, number, string, and direction semantics. This makes results independent of spill boundaries and merge fan-in. HyDB currently breaks ties by ordinal and then ID; persistent execution should prefer a stable storage identity rather than a process-assigned ordinal if results must be reproducible across reopen.

For `ORDER BY ... LIMIT k`, keep the best `k` rows in a worst-first bounded heap when the planner proves no downstream consumer needs discarded rows. PostgreSQL exposes a bounded-sort mode and heap specifically when only an initial bound is required ([`tuplesort_set_bound`](https://github.com/postgres/postgres/blob/master/src/backend/utils/sort/tuplesort.c#L845)). Include `OFFSET` in the retained bound (`k = offset + limit`) and reject/guard overflow. If an index already supplies the complete requested order, stream it and omit sorting.

For a live query, do not use repeated external sort. Maintain an ordered multiset keyed by the full deterministic key. A top-K view tracks the visible prefix and emits retractions/insertions only for membership or value changes.

## Finite joins

The planner should choose among the following implementations, but execution must be adaptive when estimates are wrong.

### Indexed nested-loop join

When the inner side has an index with the join key as its leading columns, stream outer rows, encode each join key, and perform an exact/prefix range lookup. It retains almost no join state and is the preferred plan for a selective outer side. PostgreSQL's plan documentation shows the inner index scan parameterized by the current outer row in a nested loop ([PostgreSQL `EXPLAIN` documentation](https://www.postgresql.org/docs/current/using-explain.html#USING-EXPLAIN-BASIC)). Batch/deduplicate adjacent lookup keys later to improve page locality without changing semantics.

### Adaptive in-memory to Grace hash join

Begin by building a hash table on the estimated smaller side. Charge encoded rows, bucket arrays, key material, and matched state to the reservation. If the build finishes within budget, stream and probe the other side.

If it cannot grow, convert to a partitioned Grace/hybrid hash join:

1. Choose a power-of-two partition count from measured encoded bytes and the available build budget.
2. Flush existing build rows and partition the rest by a stable hash of the normalized join key.
3. Partition the probe input with the identical hash function and seed.
4. For each `(build-i, probe-i)` pair, load the smaller side, probe the other, emit results, and release the table.

PostgreSQL follows this adaptive model: it can start with one batch, measure the real hash table, increase the number of batches when it exceeds its memory allowance, and write deferred tuples to batch files ([PostgreSQL `nodeHashjoin.c`](https://github.com/postgres/postgres/blob/master/src/backend/executor/nodeHashjoin.c)).

If one partition remains too large, recursively repartition only that pair with a new seed and a strict depth/progress limit. Measure progress: if a repartition sends effectively all rows back to one child, further hashing cannot solve a hot key. PostgreSQL similarly disables batch growth when a split retains all or none of a batch's tuples ([PostgreSQL `nodeHashjoin.c`](https://github.com/postgres/postgres/blob/master/src/backend/executor/nodeHashjoin.c#L52)). HyDB should then use a skew fallback: isolate the hot key and process its equal-key group with a bounded nested/block loop, or sort both residual partitions and use sort-merge. Never recurse indefinitely.

### Sort-merge join

Choose sort-merge when both inputs already have the join order, when external sorts are already required/reusable, or as the skew fallback. Advance ordered cursors to equal keys, then produce the Cartesian product of each equal-key group. PostgreSQL documents that merge join requires sorted inputs and may obtain that order from an index or an explicit sort ([PostgreSQL `EXPLAIN` documentation](https://www.postgresql.org/docs/current/using-explain.html#USING-EXPLAIN-BASIC)).

An equal-key group can itself exceed memory. Spill one group side as a small run and rescan it in bounded blocks against the other side. Account for output explosion separately: no join algorithm can make an intrinsically huge result cheap, so output must stream under downstream backpressure.

### Outer joins

For left outer join, an unmatched streamed probe row can be emitted after its partition has been fully probed. For right/full joins, each build record needs a matched bit. Keep it in the in-memory hash entry for the active partition and persist a compact bitmap beside a spilled build partition; after probing, scan unset records and emit null-extended rows. PostgreSQL's hash join records match state on inner tuples and has explicit phases for scanning unmatched inner rows in right/full joins ([PostgreSQL `nodeHashjoin.c`](https://github.com/postgres/postgres/blob/master/src/backend/executor/nodeHashjoin.c#L174)).

Null join-key semantics must be decided before partitioning. For ordinary equality joins, null keys do not match and outer-join null-key rows can be routed to a dedicated stream rather than hashed.

## Differential joins and spillable arrangements

Differential state is a collection of `(record, logical time, weight)` updates, not merely a set. Differential Dataflow describes arrangements as indexed batches of `(data, time, diff)` updates which are merged and compacted for shared random access ([Differential Dataflow arrangements](https://timelydataflow.github.io/differential-dataflow/chapter_5/chapter_5.html)); its join multiplies input multiplicities ([Differential Dataflow join](https://timelydataflow.github.io/differential-dataflow/chapter_2/chapter_2_5.html)). HyDB should therefore generalize `diff` from `1 | -1` to a checked integer weight before it introduces consolidation or multiple derivations.

Maintain two arrangements:

```text
join-key -> (row-id, row, logical-time, weight)
```

Each has an in-memory mutable batch for recent updates plus immutable sorted runs (or a B+ tree) for cold state. Runs carry key ranges, sparse indexes, and optionally Bloom filters; lookup merges relevant runs and consolidates equal `(key, row-id, time)` entries, dropping zero weights. Background compaction is bounded and charged like any other operator. Because arrangements are derived, they may be deleted and rebuilt from a pinned snapshot plus ordered commits.

For simultaneous deltas at time `t`, the join result must be exactly:

```text
(delta-left join right-old)
+ (left-old join delta-right)
+ (delta-left join delta-right)
```

with output weight `leftWeight * rightWeight`. A deterministic equivalent is: stage both deltas; apply/probe left against `right-old`; then apply/probe right against `left-new`. The second probe includes the cross term exactly once. Do not let independently completing asynchronous callbacks both probe `new` state, which can double-count the cross term, or both probe `old` state, which omits it. Differential Dataflow's delta-query documentation calls out this simultaneous-update duplication hazard and uses logical old/new order to prevent it ([Differential Dataflow delta queries](https://github.com/TimelyDataflow/differential-dataflow/blob/master/dogsdogsdogs/README.md)).

Keep time in stored entries until the progress frontier permits compaction. A timestamp is complete only when no upstream capability can still produce data at that time; Timely Dataflow's progress tracking is explicitly based on outstanding timestamp capabilities ([Timely Dataflow progress tracking](https://timelydataflow.github.io/timely-dataflow/chapter_5/chapter_5_2.html)). For HyDB's initial linear commit stream, the frontier can simply be the next unapplied commit sequence, provided commits are processed serially and no operator can inject an earlier sequence.

## Async scheduler, backpressure, and settlement

Replace recursive `void` emission with queued asynchronous batches:

```ts
interface Operator<Input, Output> {
  push(batch: ChangeBatch<Input>, time: LogicalTime): Promise<void>;
  seal(time: LogicalTime): Promise<void>;
  close(): Promise<void>;
}
```

`push` resolves only after the operator has durably staged any spill state and downstream has accepted its output. Bounded queues provide backpressure; a producer awaits queue capacity instead of recursively growing memory. For each subscription, the scheduler processes commit times in order, stages both join inputs for that time, and calls `seal(t)` only after every input batch at `t` has arrived. A time is settled when every reachable operator has completed `push` and `seal` for it. Only then may `OutputOperator` compare before/after state and notify the listener.

Cancellation propagates through an `AbortSignal`, stops new reads, awaits/aborts outstanding file operations where possible, closes operators in reverse topological order, and removes spill state. One failing operator fails the whole query time; partial output is not published.

This is the material migration from today's `DifferentialQuery.apply(): void` contract. Preserve a serial promise chain initially:

```ts
apply(commit: CommitBatch): Promise<void>
```

The database change loop must await each subscription's settlement (or give each subscription its own ordered bounded queue with an explicit lag policy) before advancing its observable time. Slow-listener policy should be separate from operator backpressure: compute settlement first, then either await the listener, coalesce notifications, or cancel a lagging subscription according to API contract.

## Implementation phases

1. **Resource substrate:** byte-accounted memory reservations, transient spill directories, checksummed block codec, disk limits, cancellation, metrics, and cleanup tests.
2. **Finite sort:** in-memory/external transition, bounded merge fan-in, deterministic total keys, top-N heap, and ordered-index bypass.
3. **Finite joins:** indexed nested loop, budgeted in-memory hash, adaptive partition spill, recursive repartition with progress detection, outer-join bitmaps, and sort-merge skew fallback.
4. **Async dataflow:** promise-returning operators, bounded queues, ordered commit scheduling, time sealing/settlement, and publish-after-settlement.
5. **Live arrangements:** integer weights and logical times, mutable batch plus immutable sorted runs, lookup merge/consolidation, compaction, and differential join staging.
6. **Live order/top-K:** persistent ordered multiset and incremental visible-prefix maintenance, replacing full group retention/re-sort.

## Required tests

- Run the same randomized sort with many memory budgets, row sizes, spill boundaries, merge fan-ins, nulls, and duplicate order keys; require byte-for-byte identical row-ID order.
- Compare top-N with full-sort-and-slice, including `OFFSET`, `k = 0`, and ties spanning runs.
- Differentially test every join strategy against a simple nested-loop oracle for inner, left, right, and full joins; include nulls, duplicates, negative weights, and empty sides.
- Force in-memory hash conversion after several build batches and verify no loss/duplication.
- Force recursive repartition, all-one-partition skew, huge equal-key groups, and output cancellation.
- Verify matched bitmaps across spill/reload and unmatched emission exactly once.
- For every simultaneous `delta-left`/`delta-right` combination, compare incremental output with recomputation and explicitly assert the cross term occurs once.
- Delay spill reads/writes with a controllable fake store; assert no listener notification occurs before time settlement and commits remain ordered.
- Inject checksum failures, short reads/writes, disk-budget exhaustion, memory-reservation denial, cancellation at every state transition, and process-like stale directories; assert useful errors and cleanup.
- Hold a B+ page-cache workload beside spilling operators; assert the global hard limit, operator progress floor, and cache reclamation policy under pressure.

## Decisions to keep explicit

- The canonical serialized row/key format and stable hash version become spill compatibility boundaries within a process, even though files are transient.
- Comparator semantics must be shared with indexes and query expression ordering.
- Memory estimates need a documented safety margin for JavaScript object overhead; encoding retained rows into compact buffers makes accounting more reliable.
- Subscription lag, notification coalescing, and arrangement rebuild retention are product policies, not hidden consequences of the spill implementation.
- Spill metrics and plan choice should be observable from the first release so thresholds can be tuned from workloads rather than intuition.
