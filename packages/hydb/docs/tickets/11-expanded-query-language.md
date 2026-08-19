# Ticket 11: Expanded Query Language

Status: Draft

## Objective

Extend the reference query language to cover the relational operations needed by typical applications.

## Scope

- Equality joins.
- Relations and includes.
- Grouping and count/sum aggregates.
- Distinct results.
- Multiple sort keys and ordered limits.
- Min, max, and average aggregates.
- Reference-interpreter semantics for every operation.

## Out of scope

- Recursive queries.
- Range and non-equality joins.
- Arbitrary user-defined aggregates.

## Depends on

- Ticket 03: Reference Query Engine.
- Ticket 08: Minimal Client and Server Runtimes.

Detailed acceptance criteria will be defined before implementation.
