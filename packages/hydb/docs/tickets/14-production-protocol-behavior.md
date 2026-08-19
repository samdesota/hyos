# Ticket 14: Production Protocol Behavior

Status: Draft

## Objective

Harden client/server synchronization for real network failures, restarts, slow consumers, and rolling deployments.

## Scope

- Versioned WebSocket message codec.
- Reconnect and resume from retained history.
- Snapshot fallback after compaction.
- Retry and mutation idempotency.
- Slow-consumer handling and backpressure.
- Message limits and protocol errors.
- Schema and transactor compatibility behavior.

## Out of scope

- Active-active server writes.
- Cross-region consensus.
- Alternative transports unless required by testing.

## Depends on

- Ticket 09: SQLite Authoritative Storage.
- Ticket 10: IndexedDB Client Persistence.
- Ticket 13: Scheduler, Frontiers, and Compaction.

Detailed acceptance criteria will be defined before implementation.
