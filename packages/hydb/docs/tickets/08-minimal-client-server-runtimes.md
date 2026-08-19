# Ticket 08: Minimal Client and Server Runtimes

Status: Draft

## Objective

Deliver the first complete synchronized HyDB application using memory-backed client and server runtimes.

## Scope

- Minimal client runtime.
- Minimal authoritative server runtime.
- Query subscribe and unsubscribe lifecycle.
- Mutation submission and reconciliation.
- Compatibility handshake.
- Basic query-policy enforcement.
- In-process or minimal protocol transport.

## Out of scope

- Durable adapters.
- Production reconnect and resume behavior.
- Differential execution.

## Depends on

- Ticket 07: Deterministic Synchronization Simulator.

Detailed acceptance criteria will be defined before implementation.
