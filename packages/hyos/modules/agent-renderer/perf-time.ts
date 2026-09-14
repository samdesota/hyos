// Debug logging for the tabs persist/restore path: flip to false once the
// reload wipe is diagnosed.
export const TABS_DEBUG = true;
export const tabsDebug = (message: string): void => {
  if (TABS_DEBUG) console.log(`[tabs-debug] ${message}`);
};

// Boot-time debug traces: enable with ?bootTrace=1 in the renderer URL.
const BOOT_TRACE =
  new URLSearchParams(window.location.search).get("bootTrace") === "1";
export const bootDebug = (message: string): void => {
  if (BOOT_TRACE) console.log(`[DEBUG-boot-7f2c] ${message}`);
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
