# Ticket 12: Differential Execution

Status: Draft

## Objective

Incrementally maintain supported query results behind the existing materialized-query interface.

## Scope

- Dataflow graph construction.
- Source, consolidation, map, projection, filter, concat, and negate.
- Distinct and reusable arrangements.
- Equality join.
- Count, sum, min, max, and average reductions.
- Sort and top-k maintenance.
- Continuous comparison with full recomputation.

## Out of scope

- Recursive dataflow.
- Partially ordered timestamps.
- Distributed execution.

## Depends on

- Ticket 11: Expanded Query Language.

Detailed acceptance criteria will be defined before implementation.
