import {defineDatabase} from './database.js'
import {error} from './errors.js'

export const hydb = Object.freeze({
  database: defineDatabase,
  error,
})

export {defineDatabase} from './database.js'
export type {DatabaseDefinition, DatabaseOptions} from './database.js'
export {error, HyDBError, serializeError} from './errors.js'
export type {HyDBErrorDetails, HyDBErrorValue, SerializedHyDBError} from './errors.js'
export type {
  ColumnId,
  CommitBatch,
  CommitVersion,
  DataflowUpdate,
  Difference,
  EncodedKey,
  EncodedRow,
  RowChange,
  TableId,
} from './contracts.js'
export * from './schema/index.js'
