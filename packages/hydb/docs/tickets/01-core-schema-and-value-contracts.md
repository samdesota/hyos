# Ticket 01: Core Schema and Value Contracts

Status: Draft

## Objective

Establish the shared schema metadata and canonical value contracts used by every later HyDB component.

## Scope

- Drizzle-style table, column, index, enum, foreign-key, and relation definitions.
- Schema module discovery through `hydb.database`.
- Type inference for rows, inserts, and updates.
- Canonical key and row encoding.
- Shared commit-version, row-change, and error types.

## Out of scope

- Data storage and transactions.
- Query execution.
- Synchronization.

## Depends on

None.

Detailed acceptance criteria will be defined before implementation.
