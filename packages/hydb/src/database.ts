import { type InferQueryResult, type Query } from "./query.js";
import { executeQueryPlan } from "./executor.js";
import { planQuery } from "./planner.js";
import { SubscriptionRuntime } from "./subscription.js";
import {
  invokeCommand,
  type Command,
  type InferCommandInput,
  type InferCommandResult,
} from "./command.js";
import { type AnySchema } from "./schema.js";
import { type CommitBatch, type StorageDatabase } from "./storage.js";

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

  close(): Promise<void>;
}

class QueryDatabase implements Database {
  readonly #abortController = new AbortController();
  readonly #subscriptions = new Set<SubscriptionRuntime<any>>();
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
    );
    this.#subscriptions.add(subscription);
    void subscription.ready.catch(() => {
      this.#subscriptions.delete(subscription);
      subscription.dispose();
    });
    return () => {
      this.#subscriptions.delete(subscription);
      subscription.dispose();
    };
  }

  execute<CommandValue extends Command<any, any, any>>(
    command: CommandValue,
    input: InferCommandInput<CommandValue>,
  ): Promise<InferCommandResult<CommandValue>> {
    const execution = this.#commandQueue.then(async () => {
      const snapshot = await this.storage.snapshot();
      try {
        const { result, mutations } = await invokeCommand(
          command,
          input,
          this.schema,
          snapshot,
        );
        if (mutations.length === 0) return result;
        const commit = await this.storage.commit({
          expectedHead: snapshot.commit,
          mutations,
        });
        await this.waitForSequence(commit.sequence);
        return result;
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

  start(after: number): void {
    this.#changeLoop = this.consumeChanges(after);
  }

  async close(): Promise<void> {
    this.#abortController.abort();
    this.rejectSequenceWaiters(new Error("Database is closed"));
    try {
      await this.#changeLoop;
    } finally {
      for (const subscription of this.#subscriptions) subscription.dispose();
      await Promise.allSettled(
        [...this.#subscriptions].map((subscription) => subscription.ready),
      );
      this.#subscriptions.clear();
      await this.storage.close();
    }
  }

  private async consumeChanges(after: number): Promise<void> {
    try {
      for await (const commit of this.storage.changes({
        after,
        signal: this.#abortController.signal,
      })) {
        this.applyCommit(commit);
      }
    } catch (error) {
      if (this.#abortController.signal.aborted) return;
      this.#changeFailure = error;
      this.rejectSequenceWaiters(error);
      throw error;
    }
  }

  private applyCommit(commit: CommitBatch): void {
    if (commit.sequence <= this.#sequence) return;
    for (const subscription of [...this.#subscriptions]) {
      subscription.accept(commit);
    }
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
}

export async function database(options: {
  schema: AnySchema;
  storage: StorageDatabase;
}): Promise<Database> {
  const snapshot = await options.storage.snapshot();
  const sequence = snapshot.sequence;
  await snapshot.close();

  const queryDatabase = new QueryDatabase(
    options.schema,
    options.storage,
    sequence,
  );
  queryDatabase.start(sequence);
  return queryDatabase;
}
