// Granular write-path timing, enabled with HYDB_WRITE_TRACE=1. Emits one
// line per commit showing how long the write waited in the serialized queue,
// how long the mutation apply (tree reads/writes) took, and how long the
// final fsync took — so slow sends can be attributed to disk I/O vs queueing.
const enabled = (): boolean => process.env.HYDB_WRITE_TRACE === "1";

export const writeTraceNow = (): number =>
  globalThis.performance?.now?.() ?? Date.now();

export const writeTrace = (event: string, ms: number): void => {
  if (enabled()) console.log(`[hydb-write] ${event}: ${Math.round(ms)}ms`);
};
