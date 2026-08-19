# Ticket 04: Shared Transactors

Status: Draft

## Objective

Implement named domain operations that use one definition for local prediction, authoritative execution, backend jobs, and tests.

## Scope

- `hydb.transactor` definitions and registry.
- Standard Schema-compatible input validation.
- Shared transaction runner.
- Typed reads and writes.
- Stable `tx.now`, auth context, and business errors.
- Handling of unknown frontend reads as `not-predicted`.

## Out of scope

- Network submission.
- Optimistic queue rebasing.
- Server-only external effects.

## Depends on

- Ticket 02: In-Memory Authoritative Database.
- Ticket 03: Reference Query Engine.

Detailed acceptance criteria will be defined before implementation.
