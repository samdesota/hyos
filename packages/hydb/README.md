# HyDB

HyDB is the realtime database planned for the Hyos application platform. It combines typed schemas and queries, shared optimistic transactors, authoritative backend commits, live materialized results, and deterministic client reconciliation.

This package contains the architecture, staged build tickets, and the first
working HyDB foundations.

## Design documents

- [Consumer API](./docs/api-spec.md)
- [Application architecture](./docs/application-architecture.md)
- [System components](./docs/system-components.md)
- [Differential Dataflow guide](./docs/differential-dataflow-explained.md)
- [Fractal specification](./docs/fractal/2026-08-12-hydb/hydb-spec.md)
- [Build tickets](./docs/tickets/README.md)

## Current status

Ticket 01 is complete. The package now provides typed schema definitions,
database schema discovery and validation, canonical manifests and SHA-256
identities, canonical row and primary-key codecs, and shared commit and error
contracts. Ticket 02, the in-memory authoritative database, is next.

Run the package checks with:

```sh
npm test --workspace @hyos/hydb
```
