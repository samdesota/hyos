import { schemaBuilders } from "./schema.js";
import { query } from "./query.js";
import { database } from "./database.js";
import { command } from "./command.js";

export {
  boolean,
  id,
  index,
  integer,
  json,
  number,
  text,
  timestamp,
  uniqueIndex,
  type InferInsert,
  type InferRow,
  type InferUpdate,
} from "./schema.js";

export { type InferQueryResult, type Query } from "./query.js";
export { type Database } from "./database.js";
export {
  type Command,
  type InferCommandInput,
  type InferCommandResult,
  type Transaction,
} from "./command.js";

export {
  memoryStorage,
  storageMutation,
  StorageConflictError,
  type CommitBatch,
  type CommitRequest,
  type StorageDatabase,
  type StorageKey,
  type StorageMutation,
  type StorageScan,
  type StorageSnapshot,
} from "./storage.js";

export const hydb = {
  ...schemaBuilders,
  database,
  command,
  query,
};
