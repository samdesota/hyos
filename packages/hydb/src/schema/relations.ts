import {HyDBError} from '../errors.js'
import {relationBrand} from './brands.js'
import {AnyColumn} from './columns.js'
import {AnyTable, getTableMetadata, Table} from './tables.js'

export type OneRelation = Readonly<{
  kind: 'one'
  target: AnyTable
  fields: readonly AnyColumn[]
  references: readonly AnyColumn[]
}>

export type ManyRelation = Readonly<{
  kind: 'many'
  target: AnyTable
}>

export type Relation = OneRelation | ManyRelation

export type RelationDefinition<Source extends AnyTable = AnyTable> = Readonly<{
  [relationBrand]: true
  source: Source
  relations: Readonly<Record<string, Relation>>
}>

type RelationHelpers = Readonly<{
  one<Target extends AnyTable>(
    target: Target,
    config: {fields: readonly AnyColumn[]; references: readonly AnyColumn[]},
  ): OneRelation
  many<Target extends AnyTable>(target: Target): ManyRelation
}>

export function defineRelations<Source extends AnyTable>(
  source: Source,
  define: (helpers: RelationHelpers) => Record<string, Relation>,
): RelationDefinition<Source> {
  const helpers: RelationHelpers = Object.freeze({
    one(target, config) {
      return Object.freeze({
        kind: 'one' as const,
        target,
        fields: Object.freeze([...config.fields]),
        references: Object.freeze([...config.references]),
      })
    },
    many(target) {
      return Object.freeze({kind: 'many' as const, target})
    },
  })
  const relations = define(helpers)
  if (typeof relations !== 'object' || relations === null || Array.isArray(relations)) {
    throw new HyDBError(
      'INVALID_RELATION',
      `Relations for ${getTableMetadata(source).name} must be an object`,
    )
  }
  return Object.freeze({
    [relationBrand]: true as const,
    source,
    relations: Object.freeze({...relations}),
  })
}

export function isRelationDefinition(value: unknown): value is RelationDefinition {
  return typeof value === 'object' && value !== null && relationBrand in value
}

export type InferRelations<Value extends RelationDefinition> = Value['relations']
