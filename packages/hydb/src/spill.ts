export type SpillRunKind = "sort" | "hash" | "arrangement";

export type SpillRun = Readonly<{
  id: string;
  kind: SpillRunKind;
  bytes: number;
  records: number;
}>;

export type SpillStats = Readonly<{
  maxBytes: number;
  usedBytes: number;
  sessions: number;
  runs: number;
  bytesWritten: number;
  bytesRead: number;
}>;

export interface SpillSession {
  writeRun(
    kind: SpillRunKind,
    records: readonly Uint8Array[],
  ): Promise<SpillRun>;
  readRun(run: SpillRun): AsyncIterable<Uint8Array>;
  removeRun(run: SpillRun): Promise<void>;
  close(): Promise<void>;
}

export interface SpillStore {
  createSession(options: {
    owner: string;
    signal?: AbortSignal;
  }): Promise<SpillSession>;
  stats(): SpillStats;
  close(): Promise<void>;
}

export type SpillOptions = Readonly<{
  store: SpillStore;
  /** Maximum resident working set for each spillable operator. */
  memoryBytes?: number;
}>;

export class SpillLimitExceededError extends Error {
  constructor(
    readonly requestedBytes: number,
    readonly availableBytes: number,
  ) {
    super(
      `Spill write of ${requestedBytes} bytes exceeds the ${availableBytes} spill bytes available`,
    );
    this.name = "SpillLimitExceededError";
  }
}

export class SpillCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpillCorruptionError";
  }
}

export function framedBytes(records: readonly Uint8Array[]): number {
  return records.reduce((bytes, record) => bytes + record.byteLength + 8, 0);
}

type MemoryRun = Readonly<{
  run: SpillRun;
  records: readonly Uint8Array[];
}>;

/** A deterministic test/browser adapter; unlike Node spill, bytes remain in RAM. */
export function memorySpillStore(options: { maxBytes: number }): SpillStore {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new TypeError("Spill maxBytes must be a non-negative safe integer");
  }
  let usedBytes = 0;
  let bytesWritten = 0;
  let bytesRead = 0;
  let nextSession = 0;
  let nextRun = 0;
  let closed = false;
  const sessions = new Set<SpillSession>();
  const allRuns = new Map<string, MemoryRun>();

  const closeSession = async (
    session: SpillSession,
    runs: Map<string, MemoryRun>,
  ): Promise<void> => {
    if (!sessions.delete(session)) return;
    for (const stored of runs.values()) {
      allRuns.delete(stored.run.id);
      usedBytes -= stored.run.bytes;
    }
    runs.clear();
  };

  const store: SpillStore = {
    async createSession({ signal }) {
      if (closed) throw new Error("Spill store is closed");
      if (signal?.aborted) throw signal.reason;
      const sessionId = nextSession++;
      const runs = new Map<string, MemoryRun>();
      let sessionClosed = false;
      const assertOpen = (): void => {
        if (sessionClosed) throw new Error("Spill session is closed");
        if (signal?.aborted) throw signal.reason;
      };
      const session: SpillSession = {
        async writeRun(kind, records) {
          assertOpen();
          const bytes = framedBytes(records);
          const available = options.maxBytes - usedBytes;
          if (bytes > available) {
            throw new SpillLimitExceededError(bytes, Math.max(0, available));
          }
          const run = Object.freeze({
            id: `memory:${sessionId}:${nextRun++}`,
            kind,
            bytes,
            records: records.length,
          });
          const stored = Object.freeze({
            run,
            records: Object.freeze(records.map((record) => record.slice())),
          });
          runs.set(run.id, stored);
          allRuns.set(run.id, stored);
          usedBytes += bytes;
          bytesWritten += bytes;
          return run;
        },
        async *readRun(run) {
          assertOpen();
          const stored = runs.get(run.id);
          if (stored === undefined) throw new TypeError("Unknown spill run");
          for (const record of stored.records) {
            assertOpen();
            yield record.slice();
          }
          bytesRead += stored.run.bytes;
        },
        async removeRun(run) {
          assertOpen();
          const stored = runs.get(run.id);
          if (stored === undefined) return;
          runs.delete(run.id);
          allRuns.delete(run.id);
          usedBytes -= stored.run.bytes;
        },
        async close() {
          if (sessionClosed) return;
          sessionClosed = true;
          await closeSession(session, runs);
        },
      };
      sessions.add(session);
      return session;
    },
    stats() {
      return Object.freeze({
        maxBytes: options.maxBytes,
        usedBytes,
        sessions: sessions.size,
        runs: allRuns.size,
        bytesWritten,
        bytesRead,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...sessions].map((session) => session.close()));
    },
  };
  return store;
}
