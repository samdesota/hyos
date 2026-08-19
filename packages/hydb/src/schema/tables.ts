import {HyDBError} from '../errors.js'
import {indexBrand, tableBrand} from './brands.js'
import {AnyColumn, Column, isColumn, isIdentifier} from './columns.js'

export type ColumnShape = Record<string, AnyColumn>

export type IndexDefinition = Readonly<{
  [indexBrand]: true
  name: string
  unique: boolean
  columns: readonly AnyColumn[]
}>

export type IndexBuilder = Readonly<{
  on(...columns: AnyColumn[]): IndexDefinition
}>

function makeIndex(name: string, unique: boolean): IndexBuilder {
  if (!isIdentifier(name)) {
    throw new HyDBError('INVALID_SCHEMA_NAME', `Invalid index name: ${name}`)
  }
  return Object.freeze({
    on(...columns: AnyColumn[]): IndexDefinition {
      if (columns.length === 0 || columns.some(column => !isColumn(column))) {
        throw new HyDBError('INVALID_INDEX', `Index ${name} must contain columns`)
      }
      return Object.freeze({
        [indexBrand]: true as const,
        name,
        unique,
        columns: Object.freeze([...columns]),
      })
    },
  })
}

export function index(name: string): IndexBuilder { return makeIndex(name, false) }
export function uniqueIndex(name: string): IndexBuilder { return makeIndex(name, true) }

export type TableMetadata<Columns extends ColumnShape = ColumnShape> = Readonly<{
  name: string
  columns: Columns
  indexes: readonly IndexDefinition[]
}>

export type Table<Columns extends ColumnShape = ColumnShape> = Readonly<Columns> & {
  readonly [tableBrand]: TableMetadata<Columns>
}

export type AnyTable = Table<ColumnShape>

type BoundColumns<Columns extends ColumnShape> = {
  readonly [Key in keyof Columns]: Columns[Key]
}

export function defineTable<const Columns extends ColumnShape>(
  name: string,
  columns: Columns,
  defineIndexes?: (table: BoundColumns<Columns>) => readonly IndexDefinition[],
): Table<BoundColumns<Columns>> {
  if (!isIdentifier(name)) {
    throw new HyDBError('INVALID_SCHEMA_NAME', `Invalid table name: ${name}`)
  }
  const bound = {} as BoundColumns<Columns>
  for (const [columnName, column] of Object.entries(columns)) {
    if (!isIdentifier(columnName)) {
      throw new HyDBError('INVALID_SCHEMA_NAME', `Invalid column name: ${name}.${columnName}`)
    }
    if (!isColumn(column) || column.config.tableName !== null) {
      throw new HyDBError('INVALID_COLUMN', `Invalid column definition: ${name}.${columnName}`)
    }
    ;(bound as Record<string, AnyColumn>)[columnName] = column.bind(name, columnName)
  }
  Object.freeze(bound)
  const indexes = defineIndexes?.(bound) ?? []
  if (!Array.isArray(indexes) || indexes.some(item => !(indexBrand in item))) {
    throw new HyDBError('INVALID_INDEX', `Table ${name} returned an invalid index list`)
  }
  const metadata: TableMetadata<BoundColumns<Columns>> = Object.freeze({
    name,
    columns: bound,
    indexes: Object.freeze([...indexes]),
  })
  const table = {...bound} as Table<BoundColumns<Columns>>
  Object.defineProperty(table, tableBrand, {value: metadata})
  return Object.freeze(table)
}

export function isTable(value: unknown): value is AnyTable {
  return typeof value === 'object' && value !== null && tableBrand in value
}

export function getTableMetadata<Columns extends ColumnShape>(
  table: Table<Columns>,
): TableMetadata<Columns> {
  return table[tableBrand]
}

type RowValue<C extends AnyColumn> =
  C['_']['notNull'] extends true ? C['_']['type'] : C['_']['type'] | null

type RequiredInsertKeys<Columns extends ColumnShape> = {
  [Key in keyof Columns]: Columns[Key]['_']['notNull'] extends true
    ? Columns[Key]['_']['hasDefault'] extends true ? never : Key
    : never
}[keyof Columns]

type OptionalInsertKeys<Columns extends ColumnShape> = Exclude<keyof Columns, RequiredInsertKeys<Columns>>

type MutableKeys<Columns extends ColumnShape> = {
  [Key in keyof Columns]: Columns[Key]['_']['primaryKey'] extends true ? never : Key
}[keyof Columns]

export type InferRow<Value extends AnyTable> = {
  -readonly [Key in keyof Value[typeof tableBrand]['columns']]: RowValue<Value[typeof tableBrand]['columns'][Key]>
}

export type InferInsert<Value extends AnyTable> =
  & {-readonly [Key in RequiredInsertKeys<Value[typeof tableBrand]['columns']>]: RowValue<Value[typeof tableBrand]['columns'][Key]>}
  & {-readonly [Key in OptionalInsertKeys<Value[typeof tableBrand]['columns']>]?: RowValue<Value[typeof tableBrand]['columns'][Key]>}

export type InferUpdate<Value extends AnyTable> = {
  -readonly [Key in MutableKeys<Value[typeof tableBrand]['columns']>]?: RowValue<Value[typeof tableBrand]['columns'][Key]>
}
