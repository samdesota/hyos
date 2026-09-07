// Lightweight perf timing for the session-open path: logs wall-clock
// durations to the console so slow loads can be attributed without a profiler.
export const perfNow = (): number =>
  globalThis.performance?.now?.() ?? Date.now();

// Flip to true to re-enable the [perf] session-open timing logs.
export const PERF_ENABLED = false;

export const perfLog = (label: string, ms: number): void => {
  if (!PERF_ENABLED) return;
  console.log(`[perf] ${label}: ${Math.round(ms)}ms`);
};

export const timeAsync = async <T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const start = perfNow();
  try {
    return await fn();
  } finally {
    perfLog(label, perfNow() - start);
  }
};
