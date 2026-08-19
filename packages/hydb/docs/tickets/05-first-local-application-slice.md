# Ticket 05: First Local Application Slice

Status: Draft

## Objective

Validate the proposed consumer API in one small application without networking or differential execution.

## Scope

- Projects and tasks schema.
- One shared `createTask` transactor.
- One filtered task query.
- In-memory authoritative database.
- Query refresh through full recomputation after commits.

## Out of scope

- Client/server synchronization.
- Offline behavior.
- Durable storage.

## Depends on

- Ticket 04: Shared Transactors.

Detailed acceptance criteria will be defined before implementation.
