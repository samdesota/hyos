import { schemaBuilders } from "./schema.js";
import { query } from "./query.js";
import { database } from "./database.js";
import { command } from "./command.js";
import { gateway } from "./gateway.js";
import { readPolicy } from "./read-policy.js";
import { writePolicy } from "./write-policy.js";

export {
  MemoryLimitExceededError,
  MemoryManager,
  estimateMemoryBytes,
  type MemoryAllocation,
  type MemoryHandle,
  type MemoryStats,
} from "./memory.js";
export {
  SpillCorruptionError,
  SpillLimitExceededError,
  memorySpillStore,
  type SpillRun,
  type SpillRunKind,
  type SpillSession,
  type SpillStats,
  type SpillStore,
  type SpillOptions,
} from "./spill.js";

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
export {
  planQuery,
  type PhysicalAccess,
  type PhysicalAuthorization,
  type PhysicalJoin,
  type PhysicalQueryPlan,
  type PlannedSelection,
  type PlannedSelectionValue,
  type PlannedValue,
} from "./planner.js";
export { getDatabaseSchema, type Database } from "./database.js";
export {
  type Command,
  type InferCommandInput,
  type InferCommandResult,
  type Transaction,
} from "./command.js";

export {
  type Gateway,
  type GatewayCommands,
  type GatewaySession,
  type InferGatewayCommands,
} from "./gateway.js";

export {
  createReadPolicyEnforcer,
  type ReadPolicy,
  type ReadPolicyBuilder,
} from "./read-policy.js";

export {
  AuthorizationError,
  createWritePolicyEnforcer,
  getWritePolicyPrincipalSchema,
  writePolicy,
  type TransactionReader,
  type WriteChange,
  type WritePolicy,
  type WritePolicyBuilder,
  type WritePolicyEnforcer,
} from "./write-policy.js";

export {
  memoryStorage,
  storageMutation,
  HistoryUnavailableError,
  StorageConflictError,
  type BranchName,
  type BranchSequence,
  type CommitBatch,
  type CommitId,
  type CommitRequest,
  type GarbageCollectionReport,
  type RetentionPolicy,
  type StorageDatabase,
  type StorageKey,
  type StorageMutation,
  type StorageRange,
  type StorageScan,
  type StorageSnapshot,
  type SnapshotSelector,
} from "./storage.js";

export const hydb = {
  ...schemaBuilders,
  database,
  command,
  gateway,
  query,
  readPolicy,
  writePolicy,
};
