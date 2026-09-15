// Granular write-path timing. Emits one line per commit showing how long the
// write waited in the serialized queue, how long the mutation apply (tree
// reads/writes) took, and how long the final fsync took — so slow sends can
// be attributed to disk I/O vs queueing.
export const writeTraceNow = (): number =>
  globalThis.performance?.now?.() ?? Date.now();

export const writeTrace = (event: string, ms: number): void => {
  if (process.env.HYOS_BOOT_TRACE !== "1") return;
  console.log(`[hydb-write] ${event}: ${Math.round(ms)}ms`);
};
