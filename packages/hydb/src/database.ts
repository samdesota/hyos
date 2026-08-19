import {HyDBError} from './errors.js'
import {schemaCodec, SchemaCodec} from './schema/codec.js'
import {createSchemaRegistry, SchemaManifest, SchemaModule, SchemaRegistry} from './schema/registry.js'

export type DatabaseOptions<Schema extends SchemaModule> = Readonly<{
  name: string
  version: number
  schema: Schema
  transactors?: Record<string, unknown>
}>

export type DatabaseDefinition<Schema extends SchemaModule = SchemaModule> = Readonly<{
  name: string
  version: number
  source: Schema
  schema: SchemaRegistry
  manifest: SchemaManifest
  hash: string
  codec: SchemaCodec
}>

export function defineDatabase<const Schema extends SchemaModule>(
  options: DatabaseOptions<Schema>,
): DatabaseDefinition<Schema> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.name)) {
    throw new HyDBError('INVALID_DATABASE_NAME', `Invalid database name: ${options.name}`)
  }
  if (!Number.isSafeInteger(options.version) || options.version < 1) {
    throw new HyDBError('INVALID_SCHEMA_VERSION', 'Schema version must be a positive safe integer')
  }
  if (typeof options.schema !== 'object' || options.schema === null) {
    throw new HyDBError('INVALID_SCHEMA_MODULE', 'Schema must be a module namespace object')
  }
  const registry = createSchemaRegistry(options.name, options.version, options.schema)
  return Object.freeze({
    name: options.name,
    version: options.version,
    source: options.schema,
    schema: registry,
    manifest: registry.manifest,
    hash: registry.hash,
    codec: schemaCodec,
  })
}
