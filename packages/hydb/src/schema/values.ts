import {HyDBError} from '../errors.js'
import {assertSerializable} from '../internal/canonical.js'
import {AnyColumn} from './columns.js'

function fail(column: AnyColumn, expected: string): never {
  const location = column.config.tableName === null
    ? column.config.name ?? '<unbound>'
    : `${column.config.tableName}.${column.config.name}`
  throw new HyDBError('INVALID_COLUMN_VALUE', `${location} must be ${expected}`)
}

function assertJson(value: unknown, column: AnyColumn, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(column, 'valid JSON')
    return
  }
  if (typeof value !== 'object' || value instanceof Date || seen.has(value)) {
    fail(column, 'valid JSON')
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJson(item, column, seen)
      return
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) fail(column, 'valid JSON')
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertJson(item, column, seen)
    }
  } finally {
    seen.delete(value)
  }
}

export function assertColumnValue(column: AnyColumn, value: unknown): void {
  if (value === null) {
    if (column.config.notNull) fail(column, 'non-null')
    return
  }
  switch (column.config.dataType) {
    case 'id':
    case 'string':
      if (typeof value !== 'string') fail(column, 'a string')
      return
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(column, 'a safe integer')
      return
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(column, 'a finite number')
      return
    case 'boolean':
      if (typeof value !== 'boolean') fail(column, 'a boolean')
      return
    case 'timestamp':
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(column, 'a valid Date')
      return
    case 'enum':
      if (typeof value !== 'string' || !column.config.enumValues?.includes(value)) {
        fail(column, `one of ${column.config.enumValues?.join(', ')}`)
      }
      return
    case 'json':
      assertJson(value, column, new Set())
      assertSerializable(value)
  }
}

export function sameColumnType(left: AnyColumn, right: AnyColumn): boolean {
  return left.config.dataType === right.config.dataType
    && left.config.enumName === right.config.enumName
}
