import assert from 'node:assert/strict'
import test from 'node:test'

import {hydb, HyDBError, serializeError} from '../src/index.js'
import {sha256} from '../src/internal/canonical.js'
import {
  boolean,
  defineRelations,
  defineTable,
  enumeration,
  getTableMetadata,
  id,
  index,
  integer,
  json,
  number,
  schemaCodec,
  sql,
  string,
  timestamp,
  uniqueIndex,
} from '../src/schema/index.js'

const users = defineTable(
  'users',
  {
    id: id().primaryKey(),
    email: string().notNull(),
    createdAt: timestamp().notNull().default(sql.now()),
  },
  table => [uniqueIndex('users_email_unique').on(table.email)],
)

const taskStatus = enumeration('task_status', ['todo', 'doing', 'done'])

const tasks = defineTable(
  'tasks',
  {
    id: id().primaryKey(),
    assigneeId: id().references(() => users.id),
    title: string().notNull(),
    status: taskStatus().notNull().default('todo'),
    priority: integer().notNull().default(0),
  },
  table => [index('tasks_assignee_idx').on(table.assigneeId)],
)

const taskRelations = defineRelations(tasks, ({one}) => ({
  assignee: one(users, {fields: [tasks.assigneeId], references: [users.id]}),
}))

test('builds immutable table, column, index, default, and reference metadata', () => {
  const metadata = getTableMetadata(tasks)
  assert.equal(metadata.name, 'tasks')
  assert.equal(metadata.columns.id.config.primaryKey, true)
  assert.equal(metadata.columns.id.config.notNull, true)
  assert.deepEqual(metadata.columns.status.config.enumValues, ['todo', 'doing', 'done'])
  assert.equal(metadata.columns.priority.config.defaultValue, 0)
  assert.equal(metadata.indexes[0]?.name, 'tasks_assignee_idx')
  assert.equal(metadata.columns.assigneeId.config.reference?.(), users.id)
  assert.equal(Object.isFrozen(tasks), true)
  assert.equal(Object.isFrozen(metadata), true)
})

test('discovers module definitions and creates an export-order-independent manifest', () => {
  const first = hydb.database({
    name: 'project-manager',
    version: 1,
    schema: {users, tasks, taskStatus, taskRelations, ignored: 42},
  })
  const reordered = hydb.database({
    name: 'project-manager',
    version: 1,
    schema: {taskRelations, taskStatus, tasksAlias: tasks, users, tasks},
  })

  assert.deepEqual(first.manifest, reordered.manifest)
  assert.equal(first.hash, reordered.hash)
  assert.equal(first.hash, 'cf1df4a2eb1e2d1d2e8c33c163138e97766f8875d94a9d2b5bbf2fbcec148fb7')
  assert.deepEqual([...first.schema.tables.keys()], ['tasks', 'users'])
  assert.deepEqual([...first.schema.enums.keys()], ['task_status'])
  assert.deepEqual([...first.schema.relations.keys()], ['tasks.assignee'])
  assert.equal(first.manifest.tables[0]?.columns[1]?.references?.table, 'users')
  assert.throws(
    () => (first.schema.tables as Map<string, unknown>).set('other', users),
    TypeError,
  )
})

test('rejects invalid assembled schemas with stable error codes', () => {
  const duplicateUsers = defineTable('users', {id: id().primaryKey()})
  assert.throws(
    () => hydb.database({name: 'bad', version: 1, schema: {users, duplicateUsers}}),
    (value: unknown) => value instanceof HyDBError && value.code === 'DUPLICATE_TABLE',
  )

  const noKey = defineTable('no_key', {value: string()})
  assert.throws(
    () => hydb.database({name: 'bad', version: 1, schema: {noKey}}),
    (value: unknown) => value instanceof HyDBError && value.code === 'MISSING_PRIMARY_KEY',
  )

  const absent = defineTable('absent', {id: id().primaryKey()})
  const referencing = defineTable('referencing', {
    id: id().primaryKey(),
    absentId: id().references(() => absent.id),
  })
  assert.throws(
    () => hydb.database({name: 'bad', version: 1, schema: {referencing}}),
    (value: unknown) => value instanceof HyDBError && value.code === 'INVALID_REFERENCE',
  )

  const wrongType = defineTable('wrong_type', {
    id: id().primaryKey(),
    userId: string().references(() => users.id),
  })
  assert.throws(
    () => hydb.database({name: 'bad', version: 1, schema: {users, wrongType}}),
    (value: unknown) => value instanceof HyDBError && value.code === 'REFERENCE_TYPE_MISMATCH',
  )

  const duplicateIndexes = defineTable(
    'duplicate_indexes',
    {id: id().primaryKey(), value: string()},
    table => [index('same_idx').on(table.value), index('same_idx').on(table.id)],
  )
  assert.throws(
    () => hydb.database({name: 'bad', version: 1, schema: {duplicateIndexes}}),
    (value: unknown) => value instanceof HyDBError && value.code === 'DUPLICATE_INDEX',
  )

  const invalidRelations = defineRelations(tasks, ({one}) => ({
    broken: one(users, {fields: [tasks.assigneeId], references: []}),
  }))
  assert.throws(
    () => hydb.database({
      name: 'bad', version: 1, schema: {users, tasks, taskStatus, invalidRelations},
    }),
    (value: unknown) => value instanceof HyDBError && value.code === 'INVALID_RELATION',
  )

  const invalidDefault = defineTable('invalid_default', {
    id: id().primaryKey(),
    value: string().default(sql.now() as never),
  })
  assert.throws(
    () => hydb.database({name: 'bad', version: 1, schema: {invalidDefault}}),
    (value: unknown) => value instanceof HyDBError && value.code === 'INVALID_DEFAULT',
  )
})

test('uses the standard SHA-256 algorithm for compatibility identities', () => {
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

const values = defineTable('values', {
  id: id().primaryKey(),
  text: string(),
  count: integer().notNull(),
  score: number().notNull(),
  enabled: boolean().notNull(),
  occurredAt: timestamp().notNull(),
  payload: json().notNull(),
})

test('round-trips every initial value family and canonicalizes row object order', () => {
  const row = {
    id: 'value-1',
    text: null,
    count: -4,
    score: 1.25,
    enabled: true,
    occurredAt: new Date('2026-08-18T12:34:56.789Z'),
    payload: {z: [true, null, 3], a: {second: 2, first: 1}},
  }
  const reordered = {
    payload: {a: {first: 1, second: 2}, z: [true, null, 3]},
    occurredAt: row.occurredAt,
    enabled: true,
    score: 1.25,
    count: -4,
    text: null,
    id: 'value-1',
  }
  const encoded = schemaCodec.encodeRow(values, row)
  assert.deepEqual(encoded, schemaCodec.encodeRow(values, reordered))
  assert.deepEqual(schemaCodec.decodeRow(values, encoded), row)

  const task = {id: 'task-1', assigneeId: null, title: 'Ship it', status: 'doing', priority: 2}
  assert.deepEqual(schemaCodec.decodeRow(tasks, schemaCodec.encodeRow(tasks, task)), task)
})

test('captures structured defaults instead of retaining mutable caller objects', () => {
  const original = {nested: {enabled: true}}
  const configured = defineTable('configured', {
    id: id().primaryKey(),
    settings: json().notNull().default(original),
  })
  original.nested.enabled = false
  assert.deepEqual(configured.settings.config.defaultValue, {nested: {enabled: true}})
  assert.equal(Object.isFrozen(configured.settings.config.defaultValue), true)
})

test('encodes round-trippable, naturally ordered primary keys', () => {
  const numeric = defineTable('numeric_keys', {id: number().primaryKey()})
  const negative = schemaCodec.encodeKey(numeric, -10)
  const zero = schemaCodec.encodeKey(numeric, 0)
  const positive = schemaCodec.encodeKey(numeric, 2.5)
  assert.equal(schemaCodec.compareKeys(negative, zero), -1)
  assert.equal(schemaCodec.compareKeys(zero, positive), -1)
  assert.equal(schemaCodec.decodeKey(numeric, positive), 2.5)

  const compound = defineTable('compound_keys', {
    tenant: string().primaryKey(),
    sequence: integer().primaryKey(),
  })
  const key = schemaCodec.encodeKey(compound, {tenant: 'a\0b', sequence: 7})
  assert.deepEqual(schemaCodec.decodeKey(compound, key), {tenant: 'a\0b', sequence: 7})
})

test('rejects malformed rows, values, and key encodings instead of coercing', () => {
  assert.throws(
    () => schemaCodec.encodeRow(values, {
      id: 'value-1', text: null, count: 1.5, score: 1, enabled: true,
      occurredAt: new Date(), payload: {},
    }),
    (value: unknown) => value instanceof HyDBError && value.code === 'INVALID_COLUMN_VALUE',
  )
  assert.throws(
    () => schemaCodec.decodeKey(values, new Uint8Array([0x40, 1])),
    (value: unknown) => value instanceof HyDBError && value.code === 'INVALID_KEY_ENCODING',
  )
})

test('serializes expected errors without leaking unexpected error details', () => {
  assert.deepEqual(
    serializeError(hydb.error('PROJECT_ARCHIVED', 'Project is archived', {projectId: 'p1'})),
    {code: 'PROJECT_ARCHIVED', message: 'Project is archived', details: {projectId: 'p1'}},
  )
  assert.deepEqual(serializeError(new Error('database password leaked')), {
    code: 'INTERNAL', message: 'Internal error',
  })
  assert.deepEqual(serializeError('bad'), {code: 'INTERNAL', message: 'Internal error'})
  assert.throws(
    () => hydb.error('BAD_DETAILS', undefined, {value: Number.NaN}),
    TypeError,
  )
})
