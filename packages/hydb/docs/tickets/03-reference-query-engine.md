# Ticket 03: Reference Query Engine

Status: Draft

## Objective

Provide the typed query surface and a simple full-recomputation interpreter that serves as the correctness oracle for later optimization.

## Scope

- Typed query builder.
- Canonical query AST.
- Validation and normalization.
- Primary-key lookup, filtering, projection, sorting, and limits.
- Non-incremental execution against a storage snapshot.

## Out of scope

- Joins and aggregates.
- Differential execution.
- Query synchronization.

## Depends on

- Ticket 01: Core Schema and Value Contracts.
- Ticket 02: In-Memory Authoritative Database.

Detailed acceptance criteria will be defined before implementation.
