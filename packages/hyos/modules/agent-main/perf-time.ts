// Main-process timing helpers must not import renderer code: renderer modules
// may access window during evaluation, before Electron has mounted the UI.
export const perfNow = (): number =>
  globalThis.performance?.now?.() ?? Date.now();

// Flip to true when profiling agent startup or session-open performance.
const PERF_ENABLED = false;

export const perfLog = (label: string, ms: number): void => {
  if (!PERF_ENABLED) return;
  console.log(`[perf] ${label}: ${Math.round(ms)}ms`);
};
