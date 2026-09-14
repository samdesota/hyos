// The agent finish chime, main-process side: on a session's running →
// finished transition, spawn the platform audio player as a detached child
// process. Playback bypasses the renderer entirely (no autoplay policy, no
// audio element), and the enabled preference persists in a small JSON file
// next to the agent storage rather than renderer localStorage.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentSessionId,
  AgentSessionStatus,
} from "../../capabilities/agent.js";
import { agentSoundCapability } from "../../capabilities/agent-sound.js";
import type { RemoteProvider } from "../../remote-capabilities.js";
import type { LogSink } from "../log-main/sink.js";
import type { AgentStore } from "./store.js";

export type FinishSound = Readonly<{
  provider: RemoteProvider<typeof agentSoundCapability>;
  /** Install the store watcher; returns its disposer. */
  watch(): () => void;
  dispose(): void;
}>;

export function createFinishSound(options: {
  store: AgentStore;
  /** Directory the preference file lives in (the agent storage directory). */
  storageDirectory: string;
  /** Absolute path to the bundled audio asset. */
  assetPath: string;
  sink: LogSink | undefined;
}): FinishSound {
  const { store, assetPath, sink } = options;
  const preferencePath = path.join(
    options.storageDirectory,
    "finish-sound.json",
  );
  let enabled = true;
  let loaded = false;
  let spawnGeneration = 0;
  let disposed = false;

  const trace = (message: string): void => {
    sink?.log("info", "agent-sound", message);
  };

  const loadPreference = async (): Promise<void> => {
    try {
      const raw = JSON.parse(await readFile(preferencePath, "utf8")) as {
        enabled?: unknown;
      };
      if (typeof raw.enabled === "boolean") enabled = raw.enabled;
    } catch {
      // Missing or unreadable file: keep the default (enabled).
    }
    loaded = true;
  };

  const persist = async (): Promise<void> => {
    try {
      await writeFile(
        preferencePath,
        `${JSON.stringify({ enabled }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      sink?.log(
        "warn",
        "agent-sound",
        `failed to persist preference: ${errorMessage(error)}`,
      );
    }
  };

  const play = (): void => {
    if (disposed) return;
    const generation = spawnGeneration + 1;
    spawnGeneration = generation;
    try {
      const child = spawn("afplay", [assetPath], { stdio: "ignore" });
      child.unref();
      child.once("error", (error) => {
        if (generation === spawnGeneration) {
          trace(`afplay failed: ${error.message}`);
        }
      });
    } catch (error) {
      trace(`failed to spawn afplay: ${errorMessage(error)}`);
    }
  };

  // Track the last observed status per session so we only fire on a real
  // running → finished transition, not on the initial snapshot or unrelated
  // updates.
  const lastStatus = new Map<AgentSessionId, AgentSessionStatus>();
  const check = async (): Promise<void> => {
    if (!loaded || !enabled || disposed) {
      // Still track statuses while disabled so re-enabling doesn't replay
      // stale finishes.
      const sessions = await store.listSessions();
      for (const session of sessions)
        lastStatus.set(session.id, session.status);
      return;
    }
    const sessions = await store.listSessions();
    const seen = new Set<AgentSessionId>();
    for (const session of sessions) {
      seen.add(session.id);
      const previous = lastStatus.get(session.id);
      lastStatus.set(session.id, session.status);
      if (
        (session.status === "ready" || session.status === "failed") &&
        previous === "running"
      ) {
        play();
      }
    }
    for (const id of [...lastStatus.keys()]) {
      if (!seen.has(id)) lastStatus.delete(id);
    }
  };

  let unsubscribe: (() => void) | undefined;

  return {
    provider: {
      setEnabled(next) {
        enabled = next;
        if (!next) spawnGeneration += 1; // invalidate in-flight spawns' logging
        void persist();
        return Promise.resolve();
      },
      isEnabled: () => enabled,
    },
    watch() {
      unsubscribe?.();
      unsubscribe = store.watchSessions(() => {
        void check();
      });
      void loadPreference().then(() => check());
      return () => {
        unsubscribe?.();
        unsubscribe = undefined;
      };
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}
