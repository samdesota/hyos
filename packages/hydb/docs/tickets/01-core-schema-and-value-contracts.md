# Ticket 01: Core Schema and Value Contracts

Status: Complete

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

## Acceptance criteria

### Schema definitions

- `defineTable` creates immutable, branded table and column definitions from the
  Drizzle-style API shown in the consumer API document.
- The initial `id`, `string`, `integer`, `number`, `boolean`, `timestamp`,
  `json`, and `enumeration` builders support primary keys, nullability,
  serializable defaults, foreign-key references, indexes, and unique indexes.
- `defineRelations` supports typed `one` and `many` relations and rejects
  mismatched fields, references, or tables during database assembly.
- `InferRow`, `InferInsert`, and `InferUpdate` produce the documented shapes:
  nullable/defaulted insert fields are optional and primary keys cannot be
  updated.

### Database assembly

- `hydb.database` discovers branded tables, enumerations, and relations from a
  module namespace while ignoring unrelated exports.
- Assembly rejects invalid names, duplicate physical names, missing primary
  keys, duplicate indexes, unresolved references, incompatible foreign-key
  types, and invalid relations with stable `HyDBError` codes.
- Assembly produces an immutable registry, a canonical manifest, and a stable
  SHA-256 hash. Export order and aliases of the same definition do not affect
  the manifest or hash.

### Canonical values and shared contracts

- The schema codec round-trips every initial column type, dates, structured JSON
  values, primary keys, and complete rows without depending on Node-only APIs.
- Equivalent rows have byte-identical encodings regardless of object property
  insertion order. Key encodings compare deterministically.
- Unsupported, malformed, missing, or incorrectly typed values fail with stable
  codec error codes rather than being silently coerced.
- Shared `CommitVersion`, `RowChange`, `CommitBatch`, `Difference`,
  `DataflowUpdate`, encoded-value, and serializable error contracts are exported
  from the core package.

### Verification

- Runtime tests cover schema metadata, discovery, validation, stable hashing,
  codec round trips/canonicalization, and error serialization.
- Compile-time tests cover the documented row, insert, and update inference and
  representative invalid assignments.
- The package passes TypeScript strict checking and its Node test suite.

## Implementation notes

- Schema manifests are canonical JSON hashed with SHA-256. The manifest format
  and value codec are versioned from their first release so later migrations can
  coexist with persisted data.
- Constants and the engine-owned `sql.now()` expression are the only defaults in
  this ticket. Application callbacks are rejected.
- Compatibility classification, migrations, storage enforcement, query
  expressions, and transactor discovery belong to later tickets.
