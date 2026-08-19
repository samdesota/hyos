import {assertSerializable, cloneCanonical} from '../internal/canonical.js'
import {HyDBError} from '../errors.js'
import {columnBrand, enumBrand, expressionBrand} from './brands.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | {[key: string]: JsonValue}
export type ColumnDataType =
  | 'id'
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'json'
  | 'enum'

export type EngineExpression<Type> = Readonly<{
  [expressionBrand]: true
  kind: 'now'
  readonly __type?: Type
}>

export const sql = Object.freeze({
  now(): EngineExpression<Date> {
    return Object.freeze({[expressionBrand]: true as const, kind: 'now' as const})
  },
})

function freezeValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (value instanceof Date) return Object.freeze(value)
  if (Array.isArray(value)) return Object.freeze(value.map(freezeValue))
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    ;(value as Record<string, unknown>)[key] = freezeValue(item)
  }
  return Object.freeze(value)
}

export type ReferenceTarget = () => AnyColumn

export type ColumnConfig = Readonly<{
  name: string | null
  tableName: string | null
  dataType: ColumnDataType
  notNull: boolean
  primaryKey: boolean
  hasDefault: boolean
  defaultValue?: unknown | EngineExpression<unknown>
  enumName?: string
  enumValues?: readonly string[]
  reference?: ReferenceTarget
}>

export class Column<
  Type,
  NotNull extends boolean = false,
  HasDefault extends boolean = false,
  PrimaryKey extends boolean = false,
> {
  readonly [columnBrand] = true
  declare readonly _: {
    type: Type
    notNull: NotNull
    hasDefault: HasDefault
    primaryKey: PrimaryKey
  }

  readonly config: ColumnConfig

  constructor(config: ColumnConfig) {
    this.config = Object.freeze(config)
    Object.freeze(this)
  }

  notNull(): Column<Type, true, HasDefault, PrimaryKey> {
    return new Column({...this.config, notNull: true})
  }

  primaryKey(): Column<Type, true, HasDefault, true> {
    return new Column({...this.config, notNull: true, primaryKey: true})
  }

  default(value: Type | EngineExpression<Type>): Column<Type, NotNull, true, PrimaryKey> {
    if (typeof value === 'function') {
      throw new HyDBError('INVALID_DEFAULT', 'Schema defaults cannot be functions')
    }
    if (!isEngineExpression(value)) assertSerializable(value)
    const captured = isEngineExpression(value) ? value : freezeValue(cloneCanonical(value))
    return new Column({...this.config, hasDefault: true, defaultValue: captured})
  }

  references(
    target: () => Column<Type, boolean, boolean, boolean>,
  ): Column<Type, NotNull, HasDefault, PrimaryKey> {
    if (typeof target !== 'function') {
      throw new HyDBError('INVALID_REFERENCE', 'A foreign key reference must be a callback')
    }
    return new Column({...this.config, reference: target as ReferenceTarget})
  }

  /** @internal */
  bind(tableName: string, name: string): Column<Type, NotNull, HasDefault, PrimaryKey> {
    return new Column({...this.config, tableName, name})
  }
}

export type AnyColumn = Column<unknown, boolean, boolean, boolean>
export type ColumnType<Value> = Value extends Column<infer Type, boolean, boolean, boolean>
  ? Type
  : never

function createColumn<Type>(dataType: ColumnDataType): Column<Type> {
  return new Column({
    name: null,
    tableName: null,
    dataType,
    notNull: false,
    primaryKey: false,
    hasDefault: false,
  })
}

export function id(): Column<string> { return createColumn('id') }
export function string(): Column<string> { return createColumn('string') }
export function integer(): Column<number> { return createColumn('integer') }
export function number(): Column<number> { return createColumn('number') }
export function boolean(): Column<boolean> { return createColumn('boolean') }
export function timestamp(): Column<Date> { return createColumn('timestamp') }

type StandardSchemaOutput<Schema> = Schema extends {
  readonly '~standard': {readonly types?: {readonly output: infer Output}}
} ? Output : JsonValue

export function json(): Column<JsonValue>
export function json<Schema>(schema: Schema): Column<StandardSchemaOutput<Schema>>
export function json(_schema?: unknown): Column<unknown> {
  return createColumn('json')
}

export type EnumDefinition<Values extends readonly string[] = readonly string[]> = Readonly<{
  [enumBrand]: true
  name: string
  values: Values
}>

export type EnumBuilder<Values extends readonly string[]> =
  (() => Column<Values[number]>) & EnumDefinition<Values>

export function enumeration<const Values extends readonly [string, ...string[]]>(
  name: string,
  values: Values,
): EnumBuilder<Values> {
  if (!isIdentifier(name)) {
    throw new HyDBError('INVALID_SCHEMA_NAME', `Invalid enumeration name: ${name}`)
  }
  if (values.length === 0 || values.some(value => typeof value !== 'string')) {
    throw new HyDBError('INVALID_ENUM', `Enumeration ${name} must contain string values`)
  }
  if (new Set(values).size !== values.length) {
    throw new HyDBError('DUPLICATE_ENUM_VALUE', `Enumeration ${name} has duplicate values`)
  }
  const frozenValues = Object.freeze([...values]) as unknown as Values
  const builder = (() => new Column<Values[number]>({
    name: null,
    tableName: null,
    dataType: 'enum',
    notNull: false,
    primaryKey: false,
    hasDefault: false,
    enumName: name,
    enumValues: frozenValues,
  })) as EnumBuilder<Values>
  Object.defineProperties(builder, {
    [enumBrand]: {value: true},
    name: {value: name},
    values: {value: frozenValues},
  })
  return Object.freeze(builder)
}

export function isColumn(value: unknown): value is AnyColumn {
  return typeof value === 'object' && value !== null && columnBrand in value
}

export function isEnum(value: unknown): value is EnumDefinition {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && enumBrand in value
}

export function isEngineExpression(value: unknown): value is EngineExpression<unknown> {
  return typeof value === 'object' && value !== null && expressionBrand in value
}

export function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}
