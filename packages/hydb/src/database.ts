import { type InferQueryResult, type Query } from "./query.js";
import { executeQueryPlan } from "./executor.js";
import { planQuery } from "./planner.js";
import { SubscriptionRuntime } from "./subscription.js";
import {
  invokeCommand,
  invokeTransaction,
  type Command,
  type InferCommandInput,
  type InferCommandResult,
  type Transaction,
} from "./command.js";
import { type AnySchema } from "./schema.js";
import { type CommitBatch, type StorageDatabase } from "./storage.js";
import { MemoryManager, type MemoryStats } from "./memory.js";
import type { SpillOptions } from "./spill.js";
import type { output as ZodOutput, ZodType } from "zod";
import {
  createWritePolicyEnforcer,
  type WritePolicy,
  type WritePolicyEnforcer,
} from "./write-policy.js";

const databaseSchemas = new WeakMap<Database, AnySchema>();

export interface Database {
  fetch<QueryValue extends Query<any>>(
    query: QueryValue,
  ): Promise<InferQueryResult<QueryValue>>;

  subscribe<QueryValue extends Query<any>>(
    query: QueryValue,
    listener: (result: InferQueryResult<QueryValue>) => void,
  ): () => void;

  execute<CommandValue extends Command<any, any, any>>(
    command: CommandValue,
    input: InferCommandInput<CommandValue>,
  ): Promise<InferCommandResult<CommandValue>>;

  transact<PrincipalSchema extends ZodType, Result>(
    options: Readonly<{
      principalSchema: PrincipalSchema;
      principal: ZodOutput<PrincipalSchema>;
      defaultPolicy: readonly WritePolicy<ZodOutput<PrincipalSchema>>[];
    }>,
    execute: (transaction: Transaction) => Result | PromiseLike<Result>,
  ): Promise<Awaited<Result>>;

  memoryStats(): MemoryStats;

  close(): Promise<void>;
}

class QueryDatabase implements Database {
  readonly #abortController = new AbortController();
  readonly #subscriptions = new Set<SubscriptionRuntime<any>>();
  readonly #subscriptionClosures = new Set<Promise<void>>();
  readonly #sequenceWaiters = new Map<
    number,
    Array<{ resolve: () => void; reject: (error: unknown) => void }>
  >();
  #changeLoop?: Promise<void>;
  #sequence: number;
  #changeFailure?: unknown;
  #commandQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly schema: AnySchema,
    private readonly storage: StorageDatabase,
    private readonly memory: MemoryManager,
    private readonly spill: SpillOptions | undefined,
    sequence: number,
  ) {
    this.#sequence = sequence;
  }

  async fetch<QueryValue extends Query<any>>(
    query: QueryValue,
  ): Promise<InferQueryResult<QueryValue>> {
    const snapshot = await this.storage.snapshot();
    try {
      return (await executeQueryPlan(
        planQuery(this.schema, query),
        snapshot,
        this.memory,
        this.spill,
      )) as InferQueryResult<QueryValue>;
    } finally {
      await snapshot.close();
    }
  }

  subscribe<QueryValue extends Query<any>>(
    query: QueryValue,
    listener: (result: InferQueryResult<QueryValue>) => void,
  ): () => void {
    const subscription = new SubscriptionRuntime(
      this.schema,
      this.storage,
      query,
      listener,
      this.memory,
      this.spill,
    );
    this.#subscriptions.add(subscription);
    void subscription.ready.catch(() => {
      this.disposeSubscription(subscription);
    });
    return () => {
      this.disposeSubscription(subscription);
    };
  }

  memoryStats(): MemoryStats {
    return this.memory.stats();
  }

  execute<CommandValue extends Command<any, any, any>>(
    command: CommandValue,
    input: InferCommandInput<CommandValue>,
  ): Promise<InferCommandResult<CommandValue>> {
    const execution = this.#commandQueue.then(async () => {
      const snapshot = await this.storage.snapshot();
      try {
        const invocation = await invokeCommand(
          command,
          input,
          this.schema,
          snapshot,
          this.memory,
        );
        try {
          if (invocation.mutations.length === 0) return invocation.result;
          const commit = await this.storage.commit({
            expectedHead: snapshot.commit,
            mutations: invocation.mutations,
          });
          await this.waitForSequence(commit.sequence);
          return invocation.result;
        } finally {
          invocation.releaseMemory();
        }
      } finally {
        await snapshot.close();
      }
    });
    this.#commandQueue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  transact<PrincipalSchema extends ZodType, Result>(
    options: Readonly<{
      principalSchema: PrincipalSchema;
      principal: ZodOutput<PrincipalSchema>;
      defaultPolicy: readonly WritePolicy<ZodOutput<PrincipalSchema>>[];
    }>,
    execute: (transaction: Transaction) => Result | PromiseLike<Result>,
  ): Promise<Awaited<Result>> {
    const enforcer = createWritePolicyEnforcer(
      this.schema,
      options.principalSchema,
      options.defaultPolicy,
    );
    const execution = this.#commandQueue.then(async () => {
      const snapshot = await this.storage.snapshot();
      try {
        const principal = await options.principalSchema.parseAsync(
          options.principal,
        );
        const invocation = await invokeTransaction(
          execute,
          this.schema,
          snapshot,
          this.memory,
          {
            principal,
            enforcer: enforcer as WritePolicyEnforcer<unknown>,
          },
        );
        try {
          if (invocation.mutations.length === 0) return invocation.result;
          const commit = await this.storage.commit({
            expectedHead: snapshot.commit,
            mutations: invocation.mutations,
          });
          await this.waitForSequence(commit.sequence);
          return invocation.result;
        } finally {
          invocation.releaseMemory();
        }
      } finally {
        await snapshot.close();
      }
    });
    this.#commandQueue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution as Promise<Awaited<Result>>;
  }

  start(after: number): void {
    this.#changeLoop = this.consumeChanges(after);
  }

  async close(): Promise<void> {
    this.#abortController.abort();
    this.rejectSequenceWaiters(new Error("Database is closed"));
    try {
      await this.#changeLoop;
    } finally {
      const subscriptions = [...this.#subscriptions];
      for (const subscription of subscriptions) {
        this.disposeSubscription(subscription);
      }
      await Promise.allSettled(
        subscriptions.map((subscription) => subscription.ready),
      );
      this.#subscriptions.clear();
      await Promise.allSettled(this.#subscriptionClosures);
      await this.storage.close();
    }
  }

  private async consumeChanges(after: number): Promise<void> {
    try {
      for await (const commit of this.storage.changes({
        after,
        signal: this.#abortController.signal,
      })) {
        await this.applyCommit(commit);
      }
    } catch (error) {
      if (this.#abortController.signal.aborted) return;
      this.#changeFailure = error;
      this.rejectSequenceWaiters(error);
      throw error;
    }
  }

  private async applyCommit(commit: CommitBatch): Promise<void> {
    if (commit.sequence <= this.#sequence) return;
    await Promise.all(
      [...this.#subscriptions].map((subscription) =>
        subscription.accept(commit),
      ),
    );
    this.#sequence = commit.sequence;
    for (const [sequence, waiters] of this.#sequenceWaiters) {
      if (sequence > this.#sequence) continue;
      this.#sequenceWaiters.delete(sequence);
      for (const waiter of waiters) waiter.resolve();
    }
  }

  private waitForSequence(sequence: number): Promise<void> {
    if (sequence <= this.#sequence) return Promise.resolve();
    if (this.#changeFailure !== undefined) {
      return Promise.reject(this.#changeFailure);
    }
    return new Promise<void>((resolve, reject) => {
      const waiters = this.#sequenceWaiters.get(sequence) ?? [];
      waiters.push({ resolve, reject });
      this.#sequenceWaiters.set(sequence, waiters);
    });
  }

  private rejectSequenceWaiters(error: unknown): void {
    for (const waiters of this.#sequenceWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.#sequenceWaiters.clear();
  }

  private disposeSubscription(subscription: SubscriptionRuntime<any>): void {
    this.#subscriptions.delete(subscription);
    subscription.dispose();
    const closure = subscription.whenDisposed();
    this.#subscriptionClosures.add(closure);
    void closure.then(
      () => this.#subscriptionClosures.delete(closure),
      () => this.#subscriptionClosures.delete(closure),
    );
  }
}

export async function database(options: {
  schema: AnySchema;
  storage: StorageDatabase;
  memory?: MemoryManager | Readonly<{ maxBytes: number }>;
  spill?: SpillOptions;
}): Promise<Database> {
  const snapshot = await options.storage.snapshot();
  const sequence = snapshot.sequence;
  await snapshot.close();

  const memory =
    options.memory instanceof MemoryManager
      ? options.memory
      : new MemoryManager({
          maxBytes: options.memory?.maxBytes ?? 128 * 1024 * 1024,
        });
  const queryDatabase = new QueryDatabase(
    options.schema,
    options.storage,
    memory,
    options.spill,
    sequence,
  );
  databaseSchemas.set(queryDatabase, options.schema);
  queryDatabase.start(sequence);
  return queryDatabase;
}

export function getDatabaseSchema(database: Database): AnySchema {
  const schema = databaseSchemas.get(database);
  if (schema === undefined) {
    throw new TypeError("Gateway requires a database created by hydb.database");
  }
  return schema;
}
