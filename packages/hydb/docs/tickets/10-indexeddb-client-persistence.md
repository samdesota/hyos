# Ticket 10: IndexedDB Client Persistence

Status: Draft

## Objective

Persist client cache and pending work so applications can start quickly and recover across browser restarts.

## Scope

- IndexedDB storage adapter.
- Authoritative client-cache persistence.
- Pending-mutation persistence and restoration.
- Query and synchronization metadata.
- User and database namespace isolation.
- Offline startup and close/reopen recovery.

## Out of scope

- Final multi-tab coordination policy.
- Long-term offline conflict strategies beyond normal reconciliation.
- Differential execution.

## Depends on

- Ticket 08: Minimal Client and Server Runtimes.

Detailed acceptance criteria will be defined before implementation.
