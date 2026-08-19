import {HyDBError} from '../errors.js'
import {canonicalStringify, sha256} from '../internal/canonical.js'
import {
  AnyColumn,
  EnumDefinition,
  isColumn,
  isEngineExpression,
  isEnum,
  isIdentifier,
} from './columns.js'
import {isRelationDefinition, RelationDefinition} from './relations.js'
import {AnyTable, getTableMetadata, isTable} from './tables.js'
import {assertColumnValue, sameColumnType} from './values.js'

export type SchemaModule = Record<string, unknown>

export type ColumnManifest = Readonly<{
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  default?: unknown
  enum?: string
  references?: Readonly<{table: string; column: string}>
}>

export type SchemaManifest = Readonly<{
  format: 1
  database: string
  version: number
  enums: readonly Readonly<{name: string; values: readonly string[]}>[]
  tables: readonly Readonly<{
    name: string
    columns: readonly ColumnManifest[]
    indexes: readonly Readonly<{name: string; unique: boolean; columns: readonly string[]}>[]
  }>[]
  relations: readonly Readonly<{
    name: string
    source: string
    target: string
    kind: 'one' | 'many'
    fields?: readonly string[]
    references?: readonly string[]
  }>[]
}>

class ImmutableMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #map: Map<Key, Value>
  constructor(entries: Iterable<readonly [Key, Value]>) { this.#map = new Map(entries) }
  get size(): number { return this.#map.size }
  get(key: Key): Value | undefined { return this.#map.get(key) }
  has(key: Key): boolean { return this.#map.has(key) }
  entries(): MapIterator<[Key, Value]> { return this.#map.entries() }
  keys(): MapIterator<Key> { return this.#map.keys() }
  values(): MapIterator<Value> { return this.#map.values() }
  forEach(callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void): void {
    this.#map.forEach((value, key) => callback(value, key, this))
  }
  [Symbol.iterator](): MapIterator<[Key, Value]> { return this.#map[Symbol.iterator]() }
  get [Symbol.toStringTag](): string { return 'ImmutableMap' }
}

export type SchemaRegistry = Readonly<{
  tables: ReadonlyMap<string, AnyTable>
  relations: ReadonlyMap<string, RelationDefinition>
  enums: ReadonlyMap<string, EnumDefinition>
  version: number
  manifest: SchemaManifest
  hash: string
}>

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function insertDefinition<Value extends object>(
  map: Map<string, Value>,
  identities: Set<Value>,
  name: string,
  value: Value,
  code: string,
): void {
  if (identities.has(value)) return
  identities.add(value)
  const previous = map.get(name)
  if (previous !== undefined && previous !== value) {
    throw new HyDBError(code, `Duplicate schema name: ${name}`, {name})
  }
  map.set(name, value)
}

function ownsColumn(table: AnyTable, column: AnyColumn): boolean {
  return Object.values(getTableMetadata(table).columns).includes(column)
}

function resolveReference(column: AnyColumn): AnyColumn | undefined {
  if (column.config.reference === undefined) return undefined
  let target: unknown
  try { target = column.config.reference() } catch (cause) {
    throw new HyDBError('INVALID_REFERENCE', 'Foreign-key reference could not be resolved', {
      table: column.config.tableName,
      column: column.config.name,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
  if (!isColumn(target) || target.config.tableName === null || target.config.name === null) {
    throw new HyDBError('INVALID_REFERENCE', 'Foreign-key reference did not resolve to a bound column')
  }
  return target
}

function validateTables(tables: Map<string, AnyTable>, enums: Map<string, EnumDefinition>): void {
  for (const table of tables.values()) {
    const metadata = getTableMetadata(table)
    const columns = Object.values(metadata.columns)
    const primaryKeys = columns.filter(column => column.config.primaryKey)
    if (primaryKeys.length === 0) {
      throw new HyDBError('MISSING_PRIMARY_KEY', `Table ${metadata.name} has no primary key`)
    }
    for (const key of primaryKeys) {
      if (key.config.dataType === 'json' || key.config.dataType === 'boolean') {
        throw new HyDBError('INVALID_PRIMARY_KEY', `Unsupported primary-key type on ${metadata.name}.${key.config.name}`)
      }
    }
    const indexNames = new Set<string>()
    for (const item of metadata.indexes) {
      if (indexNames.has(item.name)) {
        throw new HyDBError('DUPLICATE_INDEX', `Duplicate index ${item.name} on ${metadata.name}`)
      }
      indexNames.add(item.name)
      if (item.columns.some(column => !ownsColumn(table, column))) {
        throw new HyDBError('INVALID_INDEX', `Index ${item.name} contains a column from another table`)
      }
    }
    for (const column of columns) {
      if (column.config.dataType === 'enum') {
        const definition = enums.get(column.config.enumName ?? '')
        if (definition === undefined) {
          throw new HyDBError('UNKNOWN_ENUM', `Enumeration ${column.config.enumName} was not exported`)
        }
      }
      if (column.config.hasDefault) {
        if (isEngineExpression(column.config.defaultValue)) {
          if (column.config.defaultValue.kind === 'now' && column.config.dataType !== 'timestamp') {
            throw new HyDBError('INVALID_DEFAULT', `sql.now() requires a timestamp column`)
          }
        } else {
          assertColumnValue(column, column.config.defaultValue)
        }
      }
      const target = resolveReference(column)
      if (target === undefined) continue
      const targetTable = tables.get(target.config.tableName!)
      if (targetTable === undefined || !ownsColumn(targetTable, target)) {
        throw new HyDBError('INVALID_REFERENCE', `Referenced table ${target.config.tableName} was not exported`)
      }
      if (!sameColumnType(column, target)) {
        throw new HyDBError('REFERENCE_TYPE_MISMATCH', `Foreign-key types do not match for ${metadata.name}.${column.config.name}`)
      }
      const targetMetadata = getTableMetadata(targetTable)
      const uniquelyAddressable = target.config.primaryKey || targetMetadata.indexes.some(
        item => item.unique && item.columns.length === 1 && item.columns[0] === target,
      )
      if (!uniquelyAddressable) {
        throw new HyDBError('INVALID_REFERENCE', `Referenced column ${target.config.tableName}.${target.config.name} is not unique`)
      }
    }
  }
}

function validateRelations(
  relations: readonly RelationDefinition[],
  tables: Map<string, AnyTable>,
): Map<string, RelationDefinition> {
  const result = new Map<string, RelationDefinition>()
  for (const definition of relations) {
    const sourceName = getTableMetadata(definition.source).name
    if (tables.get(sourceName) !== definition.source) {
      throw new HyDBError('INVALID_RELATION', `Relation source ${sourceName} was not exported`)
    }
    for (const [name, relation] of Object.entries(definition.relations)) {
      const identity = `${sourceName}.${name}`
      if (!isIdentifier(name) || typeof relation !== 'object' || relation === null) {
        throw new HyDBError('INVALID_RELATION', `Invalid relation ${identity}`)
      }
      if (result.has(identity)) {
        throw new HyDBError('DUPLICATE_RELATION', `Duplicate relation ${identity}`)
      }
      if (!isTable(relation.target)) {
        throw new HyDBError('INVALID_RELATION', `Relation ${identity} has an invalid target`)
      }
      const targetName = getTableMetadata(relation.target).name
      if (tables.get(targetName) !== relation.target) {
        throw new HyDBError('INVALID_RELATION', `Relation target ${targetName} was not exported`)
      }
      if (relation.kind === 'one') {
        if (!Array.isArray(relation.fields) || !Array.isArray(relation.references)
          || relation.fields.some(field => !isColumn(field))
          || relation.references.some(reference => !isColumn(reference))
          || relation.fields.length === 0
          || relation.fields.length !== relation.references.length) {
          throw new HyDBError('INVALID_RELATION', `Relation ${identity} has mismatched fields and references`)
        }
        for (let index = 0; index < relation.fields.length; index++) {
          const field = relation.fields[index]!
          const reference = relation.references[index]!
          if (!ownsColumn(definition.source, field) || !ownsColumn(relation.target, reference)) {
            throw new HyDBError('INVALID_RELATION', `Relation ${identity} uses columns from the wrong table`)
          }
          if (!sameColumnType(field, reference)) {
            throw new HyDBError('RELATION_TYPE_MISMATCH', `Relation ${identity} uses incompatible columns`)
          }
        }
      } else if (relation.kind !== 'many') {
        throw new HyDBError('INVALID_RELATION', `Relation ${identity} has an invalid kind`)
      }
      result.set(identity, definition)
    }
  }
  return result
}

function createManifest(
  database: string,
  version: number,
  tables: Map<string, AnyTable>,
  enums: Map<string, EnumDefinition>,
  relationDefinitions: readonly RelationDefinition[],
): SchemaManifest {
  const enumManifest = [...enums.values()]
    .sort((left, right) => compareNames(left.name, right.name))
    .map(item => Object.freeze({name: item.name, values: Object.freeze([...item.values])}))
  const tableManifest = [...tables.values()]
    .sort((left, right) => compareNames(getTableMetadata(left).name, getTableMetadata(right).name))
    .map(table => {
      const metadata = getTableMetadata(table)
      const columns = Object.values(metadata.columns).map(column => {
        const target = resolveReference(column)
        const result: Record<string, unknown> = {
          name: column.config.name!,
          type: column.config.dataType,
          nullable: !column.config.notNull,
          primaryKey: column.config.primaryKey,
        }
        if (column.config.hasDefault) {
          result.default = isEngineExpression(column.config.defaultValue)
            ? {$expression: column.config.defaultValue.kind}
            : column.config.defaultValue
        }
        if (column.config.enumName !== undefined) result.enum = column.config.enumName
        if (target !== undefined) {
          result.references = Object.freeze({table: target.config.tableName!, column: target.config.name!})
        }
        return Object.freeze(result) as ColumnManifest
      })
      const indexes = [...metadata.indexes]
        .sort((left, right) => compareNames(left.name, right.name))
        .map(item => Object.freeze({
          name: item.name,
          unique: item.unique,
          columns: Object.freeze(item.columns.map(column => column.config.name!)),
        }))
      return Object.freeze({
        name: metadata.name,
        columns: Object.freeze(columns),
        indexes: Object.freeze(indexes),
      })
    })
  const relationManifest = relationDefinitions.flatMap(definition => {
    const source = getTableMetadata(definition.source).name
    return Object.entries(definition.relations).map(([name, relation]) => {
      const result: Record<string, unknown> = {
        name,
        source,
        target: getTableMetadata(relation.target).name,
        kind: relation.kind,
      }
      if (relation.kind === 'one') {
        result.fields = Object.freeze(relation.fields.map(column => column.config.name!))
        result.references = Object.freeze(relation.references.map(column => column.config.name!))
      }
      return Object.freeze(result) as SchemaManifest['relations'][number]
    })
  }).sort((left, right) => compareNames(`${left.source}.${left.name}`, `${right.source}.${right.name}`))
  return Object.freeze({
    format: 1 as const,
    database,
    version,
    enums: Object.freeze(enumManifest),
    tables: Object.freeze(tableManifest),
    relations: Object.freeze(relationManifest),
  })
}

export function createSchemaRegistry(
  database: string,
  version: number,
  module: SchemaModule,
): SchemaRegistry {
  const tables = new Map<string, AnyTable>()
  const enums = new Map<string, EnumDefinition>()
  const tableIdentities = new Set<AnyTable>()
  const enumIdentities = new Set<EnumDefinition>()
  const relationIdentities = new Set<RelationDefinition>()
  const relationDefinitions: RelationDefinition[] = []
  for (const value of Object.values(module)) {
    if (isTable(value)) {
      insertDefinition(tables, tableIdentities, getTableMetadata(value).name, value, 'DUPLICATE_TABLE')
    } else if (isEnum(value)) {
      insertDefinition(enums, enumIdentities, value.name, value, 'DUPLICATE_ENUM')
    } else if (isRelationDefinition(value) && !relationIdentities.has(value)) {
      relationIdentities.add(value)
      relationDefinitions.push(value)
    }
  }
  validateTables(tables, enums)
  const relations = validateRelations(relationDefinitions, tables)
  const manifest = createManifest(database, version, tables, enums, relationDefinitions)
  const hash = sha256(canonicalStringify(manifest))
  return Object.freeze({
    tables: new ImmutableMap([...tables.entries()].sort(([left], [right]) => compareNames(left, right))),
    relations: new ImmutableMap([...relations.entries()].sort(([left], [right]) => compareNames(left, right))),
    enums: new ImmutableMap([...enums.entries()].sort(([left], [right]) => compareNames(left, right))),
    version,
    manifest,
    hash,
  })
}
