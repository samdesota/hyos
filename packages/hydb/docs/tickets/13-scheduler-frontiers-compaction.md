# Ticket 13: Scheduler, Frontiers, and Compaction

Status: Draft

## Objective

Make incremental execution responsive and bounded under multiple active queries and sustained changes.

## Scope

- Fair bounded-work scheduler.
- Scalar progress frontiers.
- Arrangement sharing and lifecycle.
- Trace merging and compaction.
- Backpressure signals.
- Memory accounting and cancellation.

## Out of scope

- Partially ordered frontier antichains.
- Distributed scheduling.
- Multi-region execution.

## Depends on

- Ticket 12: Differential Execution.

Detailed acceptance criteria will be defined before implementation.
