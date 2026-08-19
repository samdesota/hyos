# Ticket 09: SQLite Authoritative Storage

Status: Draft

## Objective

Add the first durable authoritative backend while preserving the semantics established by the memory adapter.

## Scope

- SQLite schema translation.
- Storage-plan translation and safe parameter binding.
- Atomic transactions and constraints.
- Persistent ordered commit log.
- Restart and recovery behavior.
- Shared conformance and randomized comparison against memory storage.

## Out of scope

- Distributed writers.
- Database federation.
- Browser persistence.

## Depends on

- Ticket 02: In-Memory Authoritative Database.
- Ticket 08: Minimal Client and Server Runtimes.

Detailed acceptance criteria will be defined before implementation.
