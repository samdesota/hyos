// Debug logging for the tabs persist/restore path: flip to false once the
// reload wipe is diagnosed.
export const TABS_DEBUG = false;
export const tabsDebug = (message: string): void => {
  if (TABS_DEBUG) console.log(`[tabs-debug] ${message}`);
};

// Lightweight perf timing for the session-open path: logs wall-clock
// durations to the console so slow loads can be attributed without a profiler.
export const perfNow = (): number =>
  globalThis.performance?.now?.() ?? Date.now();

// Flip to false to silence the [perf] timing logs.
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
