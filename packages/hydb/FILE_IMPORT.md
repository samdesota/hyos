# File database → LMDB importer

Build from the repository root:

```sh
npm run build --workspace @hyos/hydb
```

Stop the app before importing its database. The importer does not acquire a
cross-process writer lock; source identity/size/modification-time and streaming
SHA-256 content checks detect
changes but are not a replacement for a quiescent source.

Use a **new destination directory**:

```sh
node --import tsx packages/hydb/scripts/import-file.mjs \
  packages/hyos/.data/agent/hydb.data \
  packages/hyos/.data/agent-lmdb \
  'packages/hyos/modules/agent-main/model.ts#agentSchema'
```

The CLI loads the schema through CommonJS (matching HyOS's TypeScript loader and
HyDB's CommonJS build). ESM applications can call the exported
`importFileStorage({ sourceFile, destinationDirectory, schema })` API directly
with their ESM schema.

## Preservation and verification

- Source opens read-only. Torn/corrupt records reject rather than being repaired.
- Copies only pages reachable from published commits; keeps original page and
  commit IDs, timestamps, changes, branch heads/bases/sequences, history floors,
  retention policy and named retained commits.
- Preserves older-schema historical commits unchanged. Active branch heads must
  match the supplied schema. KV still rejects snapshots of older-schema commits;
  importing does not add schema migration support.
- Writes one page per durable batch, bounding payload buffering by page size,
  then reopens the backend and compares every copied page, commit, branch,
  history entry and named retain against the source.
- Runs full ordered table and secondary-index scans on every branch head,
  comparing row counts and content hashes. Also tests reverse/limited scans,
  primary-key point lookups, bounded ranges, and index-prefix lookups whose
  parameters come from actual rows. For HyOS these exercise session ordering,
  messages by session, chunks by message/session, and the other declared indexes.
- Writes `import-report.json` containing query names, counts and SHA-256 hashes,
  without row contents or sampled query parameter values.
- Publishes database metadata only after verification. An interrupted import
  remains incomplete and cannot open as a valid database. It is not resumable;
  retry with a new destination. Existing directories are never overwritten.

The import needs memory for commit locations and visited page IDs, plus the
largest page/commit/query batch. It is not constant-memory for arbitrary data.
Per-page durable writes prioritize simple recovery over bulk-import throughput.

## Cutover scope

This command imports **only the database**. It does not change the application
manifest or backend, start the app, or copy sibling media/preferences files.
Those files must be preserved and their paths handled when implementing the
application cutover. Keep the original file database as the rollback source.

## Tests

`npm test --workspace @hyos/hydb` includes importer fixtures with sessions and
ordered text chunks, nullable values, dates, Unicode, history, branches, edits,
deletes, post-import writes, and GC. Failure tests cover corrupt sources,
corrupted readback, changing sources, incompatible branch schemas, and existing
destinations.

## Real-data validation (September 17, 2026)

Tested on an isolated copy of the 146,259,080-byte HyOS agent database.
The live database and application backend were not changed.

- Preserved 201 commits and 8,585 reachable pages.
- Matched 79 before/after query fingerprints across nine tables.
- Included 90 sessions, 16,709 messages, and 63,135 message chunks.
- Preserved one older-schema historical commit unchanged.
- Passed 188 Node tests, five Electron tests, and the HyOS check.

[Query counts and hashes](benchmarks/results/import-2026-09-17.json)
contain no message contents.
