import type { ReloadState } from "../../capabilities/reload.js";

export function relevantChange(filename: string): boolean {
  const name = filename.replaceAll("\\", "/");
  if (
    name
      .split("/")
      .some((part) =>
        ["node_modules", "generated", ".data", ".git"].includes(part),
      )
  )
    return false;
  return /\.(?:tsx?|jsx?|css)$/.test(name);
}

export function createReloadController(
  reload: () => Promise<void>,
  publish: (state: ReloadState) => void,
) {
  let revision = 0;
  let state: ReloadState = { pending: false, reloading: false, error: null };
  const update = (next: ReloadState) => {
    state = next;
    publish(state);
  };
  return {
    state: () => state,
    changed(filename: string) {
      if (!relevantChange(filename)) return;
      revision++;
      update({ ...state, pending: true });
    },
    async reload() {
      if (state.reloading) return;
      const started = revision;
      update({ ...state, reloading: true, error: null });
      try {
        await reload();
        update({
          pending: revision !== started,
          reloading: false,
          error: null,
        });
      } catch (error) {
        update({
          pending: true,
          reloading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
