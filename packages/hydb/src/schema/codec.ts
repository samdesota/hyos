import {EncodedKey, EncodedRow} from '../contracts.js'
import {HyDBError} from '../errors.js'
import {canonicalBytes, parseCanonicalBytes} from '../internal/canonical.js'
import {AnyColumn} from './columns.js'
import {AnyTable, getTableMetadata} from './tables.js'
import {assertColumnValue} from './values.js'

export interface SchemaCodec {
  encodeKey(table: AnyTable, key: unknown): EncodedKey
  decodeKey(table: AnyTable, key: EncodedKey): unknown
  encodeRow(table: AnyTable, row: unknown): EncodedRow
  decodeRow(table: AnyTable, row: EncodedRow): unknown
  compareKeys(left: EncodedKey, right: EncodedKey): number
}

function primaryColumns(table: AnyTable): AnyColumn[] {
  return Object.values(getTableMetadata(table).columns).filter(column => column.config.primaryKey)
}

function numberBytes(value: number): number[] {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, Object.is(value, -0) ? 0 : value, false)
  if ((bytes[0]! & 0x80) !== 0) {
    for (let index = 0; index < bytes.length; index++) bytes[index] = ~bytes[index]! & 0xff
  } else {
    bytes[0] = bytes[0]! ^ 0x80
  }
  return [...bytes]
}

function decodeNumber(bytes: Uint8Array, offset: number): number {
  if (offset + 8 > bytes.length) throw new HyDBError('INVALID_KEY_ENCODING', 'Truncated numeric key')
  const value = bytes.slice(offset, offset + 8)
  if ((value[0]! & 0x80) !== 0) {
    value[0] = value[0]! ^ 0x80
  } else {
    for (let index = 0; index < value.length; index++) value[index] = ~value[index]! & 0xff
  }
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getFloat64(0, false)
}

function stringBytes(value: string): number[] {
  const result: number[] = []
  for (const byte of new TextEncoder().encode(value)) {
    if (byte === 0) result.push(0, 0xff)
    else result.push(byte)
  }
  result.push(0, 0)
  return result
}

function decodeString(bytes: Uint8Array, state: {offset: number}): string {
  const result: number[] = []
  while (state.offset < bytes.length) {
    const byte = bytes[state.offset++]!
    if (byte !== 0) {
      result.push(byte)
      continue
    }
    const escaped = bytes[state.offset++]
    if (escaped === 0) {
      try { return new TextDecoder('utf-8', {fatal: true}).decode(new Uint8Array(result)) }
      catch { throw new HyDBError('INVALID_KEY_ENCODING', 'String key is not valid UTF-8') }
    }
    if (escaped === 0xff) result.push(0)
    else throw new HyDBError('INVALID_KEY_ENCODING', 'Invalid string-key escape')
  }
  throw new HyDBError('INVALID_KEY_ENCODING', 'Unterminated string key')
}

function encodeKeyPart(column: AnyColumn, value: unknown): number[] {
  assertColumnValue(column, value)
  switch (column.config.dataType) {
    case 'id':
    case 'string':
    case 'enum': return [0x40, ...stringBytes(value as string)]
    case 'integer': return [0x31, ...numberBytes(value as number)]
    case 'number': return [0x30, ...numberBytes(value as number)]
    case 'timestamp': return [0x50, ...numberBytes((value as Date).getTime())]
    case 'boolean': return [(value as boolean) ? 0x21 : 0x20]
    case 'json': throw new HyDBError('INVALID_PRIMARY_KEY', 'JSON values cannot be primary keys')
  }
}

function decodeKeyPart(column: AnyColumn, bytes: Uint8Array, state: {offset: number}): unknown {
  const tag = bytes[state.offset++]
  switch (column.config.dataType) {
    case 'id':
    case 'string':
    case 'enum':
      if (tag !== 0x40) throw new HyDBError('INVALID_KEY_ENCODING', 'Expected a string key')
      return decodeString(bytes, state)
    case 'integer':
      if (tag !== 0x31) throw new HyDBError('INVALID_KEY_ENCODING', 'Expected an integer key')
      {
        const result = decodeNumber(bytes, state.offset)
        state.offset += 8
        assertColumnValue(column, result)
        return result
      }
    case 'number':
      if (tag !== 0x30) throw new HyDBError('INVALID_KEY_ENCODING', 'Expected a numeric key')
      {
        const result = decodeNumber(bytes, state.offset)
        state.offset += 8
        assertColumnValue(column, result)
        return result
      }
    case 'timestamp':
      if (tag !== 0x50) throw new HyDBError('INVALID_KEY_ENCODING', 'Expected a timestamp key')
      {
        const result = new Date(decodeNumber(bytes, state.offset))
        state.offset += 8
        assertColumnValue(column, result)
        return result
      }
    case 'boolean':
      if (tag !== 0x20 && tag !== 0x21) throw new HyDBError('INVALID_KEY_ENCODING', 'Expected a boolean key')
      return tag === 0x21
    case 'json': throw new HyDBError('INVALID_PRIMARY_KEY', 'JSON values cannot be primary keys')
  }
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HyDBError(code, 'Expected an object')
  }
  return value as Record<string, unknown>
}

export const schemaCodec = Object.freeze<SchemaCodec>({
  encodeKey(table, key) {
    const columns = primaryColumns(table)
    let values: unknown[]
    if (columns.length === 1) {
      const name = columns[0]!.config.name!
      values = typeof key === 'object' && key !== null && !Array.isArray(key) && name in key
        ? [(key as Record<string, unknown>)[name]]
        : [key]
    } else if (Array.isArray(key)) {
      if (key.length !== columns.length) {
        throw new HyDBError('INVALID_KEY', 'Compound key has the wrong number of values')
      }
      values = key
    } else {
      const record = asRecord(key, 'INVALID_KEY')
      values = columns.map(column => record[column.config.name!])
    }
    return new Uint8Array(columns.flatMap((column, index) => encodeKeyPart(column, values[index])))
  },

  decodeKey(table, key) {
    const columns = primaryColumns(table)
    const state = {offset: 0}
    const values = columns.map(column => decodeKeyPart(column, key, state))
    if (state.offset !== key.length) {
      throw new HyDBError('INVALID_KEY_ENCODING', 'Key contains trailing bytes')
    }
    return columns.length === 1
      ? values[0]
      : Object.fromEntries(columns.map((column, index) => [column.config.name!, values[index]]))
  },

  encodeRow(table, row) {
    const input = asRecord(row, 'INVALID_ROW')
    const metadata = getTableMetadata(table)
    const known = new Set(Object.keys(metadata.columns))
    const unknown = Object.keys(input).find(name => !known.has(name))
    if (unknown !== undefined) {
      throw new HyDBError('UNKNOWN_COLUMN', `Unknown column ${metadata.name}.${unknown}`)
    }
    const output: Record<string, unknown> = {}
    for (const [name, column] of Object.entries(metadata.columns)) {
      if (!Object.hasOwn(input, name)) {
        throw new HyDBError('MISSING_COLUMN', `Missing column ${metadata.name}.${name}`)
      }
      assertColumnValue(column, input[name])
      output[name] = input[name]
    }
    return canonicalBytes(output)
  },

  decodeRow(table, row) {
    const decoded = parseCanonicalBytes(row)
    const input = asRecord(decoded, 'INVALID_ROW_ENCODING')
    // Re-encoding performs strict shape/type validation and also rejects unknown fields.
    this.encodeRow(table, input)
    return input
  },

  compareKeys(left, right) {
    const length = Math.min(left.length, right.length)
    for (let index = 0; index < length; index++) {
      if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
    }
    return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
  },
})
