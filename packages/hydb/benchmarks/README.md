# Storage benchmarks

Compare the existing append-only file engine against the LMDB KV prototype:

```sh
npm run bench:storage --workspace @hyos/hydb
# Optional output path (relative to packages/hydb):
npm run bench:storage --workspace @hyos/hydb -- benchmarks/results/my-run.json
# Default: three fresh-process repetitions of each engine/dataset pair.
HYDB_BENCH_REPEATS=1 npm run bench:storage --workspace @hyos/hydb
```

LMDB requires native memory-mapping/locking permissions; the macOS agent sandbox
aborts when opening LMDB, so run these benchmarks outside it. All databases live
in fresh OS temporary directories and are deleted after each worker. App data is
never opened. The driver runs workers sequentially and saves results after each
one, alternating engine order between repetitions. Each worker has a five-minute
timeout. A forcibly terminated worker may leave its temporary directory behind.

## Workloads

| Setting                              | Small |  Large |
| ------------------------------------ | ----: | -----: |
| Rows                                 | 2,000 |    256 |
| Payload per row                      | 256 B | 16 KiB |
| Single-row measured updates          |   200 |    100 |
| Rows per update batch                |    64 |     16 |
| Measured batches                     |    12 |     12 |
| Warm point reads                     | 2,000 |    500 |
| Cache-disabled point reads           |   300 |    150 |
| Full table scans                     |     8 |      8 |
| Indexed reads                        |    32 |     32 |
| Additional updates before GC traffic |   200 |    100 |

Both engines use the same primary/secondary indexes, 64-entry B+ tree pages,
16 MiB HyDB cache, durable acknowledged commits, and retention of the latest five
commits plus mandatory roots. LMDB's GC batch size is the default 128. There is no
compression or asynchronous durability relaxation. A deterministic seeded random
sequence selects update/read keys. Mutations also exercise the existing secondary
index rewrite behavior. The harness includes row construction and head lookup in
write timings, with the same code on both backends. Twenty unmeasured single-row
writes warm the update path after seeding.

Reads:

- Warm point reads and scans reuse one snapshot after a full-table warmup.
- Cache-disabled reads reopen with the **HyDB** cache set to zero. OS filesystem
  caches remain warm: this is not a cold-disk test.
- Indexed reads each return 1/16 of the table.

GC:

- Run concurrent streams of 100 single-row writes and 100 snapshot/get/close
  reads, first without GC and then with GC. Each loop yields between operations.
- Record full-cycle GC elapsed time, per-operation percentiles/maxima, event-loop
  delay, and how many operations finish before GC finishes.
- Run a second, quiescent collection because writes arriving during the first
  collection intentionally remain protected until a later cycle.
- Perform another 100 updates to observe growth versus reuse of reclaimed space.
- Verify every final row against an independent map, then reopen and verify again.

`unitsPerSecond` means rows/s for seed/batched writes/scans and operations/s for
single writes/point reads/index queries. Traffic summaries use the whole traffic
window, including GC completion; they are not standalone throughput estimates.
For reads/writes started during GC, percentiles include any operation that waited
until after GC to complete. Completion counters count only operations that finish
before GC ends. Empty during-GC summaries on the no-GC baseline are not meaningful.

Memory is sampled at 10 ms intervals and operation boundaries. Peak RSS also uses
the OS process high-water mark; it includes LMDB's resident memory-mapped pages,
not just JS heap. Disk measurements sum all files in the database directory,
including checkpoints/lock files; allocated bytes use `stat.blocks * 512`.
Engine-provided GC byte reports differ in scope and must not be compared as
physical disk usage.

Three repetitions on one live workstation are directional, not production sizing
or a confidence interval. There are only 12 timed write batches and eight scans
per repetition; their tail percentiles have few samples. Fresh worker processes
reduce cross-engine heap/JIT contamination but do not evict OS caches. No power
loss, cloud latency, distributed readers, or production-sized database is tested.

[September 15 results](results/storage-2026-09-15.md)
