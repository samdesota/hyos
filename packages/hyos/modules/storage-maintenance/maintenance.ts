import { copyFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { GarbageCollectionReport, StorageDatabase } from "@hyos/hydb";

import type { LogSink } from "../log-main/sink.js";

const execFileAsync = promisify(execFile);

export type StorageMaintenanceOptions = Readonly<{
  /** Opened hydb node storage whose dead history should be reclaimed. */
  storage: StorageDatabase;
  /** Storage directory containing the hydb.data append-only file. */
  directory: string;
  sink: LogSink;
  source: string;
  dataFileName?: string;
  /** How often collection runs. Defaults to 10 minutes. */
  intervalMs?: number;
  /** Delay before the first collection after startup. Defaults to 15s. */
  initialDelayMs?: number;
  now?: () => number;
}>;

export const defaultMaintenanceIntervalMs = 10 * 60 * 1000;
export const defaultMaintenanceInitialDelayMs = 15 * 1000;

/**
 * Schedules periodic garbage collection for a hydb node storage.
 *
 * Before the first collection ever runs against a storage file, the file is
 * backed up next to itself (`<data>.pre-gc-backup`) so the one-time compaction
 * of an unbounded (pre-retention) file is reversible. Subsequent collections
 * reuse the same backup and skip copying.
 *
 * Returns a disposer that cancels the timers; collection never throws into the
 * caller — failures are logged through the sink.
 */
export function scheduleStorageCollection(
  options: StorageMaintenanceOptions,
): () => void {
  const dataFileName = options.dataFileName ?? "hydb.data";
  const intervalMs = options.intervalMs ?? defaultMaintenanceIntervalMs;
  const initialDelayMs =
    options.initialDelayMs ?? defaultMaintenanceInitialDelayMs;
  const now = options.now ?? (() => Date.now());
  const dataPath = path.join(options.directory, dataFileName);
  const backupPath = `${dataPath}.pre-gc-backup`;
  const log = (level: "info" | "warn" | "error", msg: string): void => {
    options.sink.log(level, options.source, msg);
  };

  let running = false;
  let disposed = false;
  let initialTimer: NodeJS.Timeout | undefined;

  const backupDataFile = async (): Promise<"clone" | "copy" | "existing"> => {
    try {
      await stat(backupPath);
      return "existing";
    } catch {
      // APFS clone first (instant even for very large files); fall back to a
      // full byte copy when cloning is unsupported.
      try {
        await execFileAsync("cp", ["-c", dataPath, backupPath]);
        return "clone";
      } catch {
        await copyFile(dataPath, backupPath);
        return "copy";
      }
    }
  };

  const describe = (report: GarbageCollectionReport): string =>
    `collected commits=${report.commitsCollected} ` +
    `bytes=${report.bytesBefore}->${report.bytesAfter} ` +
    `reclaimed=${report.bytesReclaimed}`;

  const collect = async (): Promise<void> => {
    if (running || disposed) return;
    running = true;
    try {
      const mode = await backupDataFile();
      if (mode !== "existing") {
        log("info", `storage pre-GC backup created (${mode}): ${backupPath}`);
      }
      const startedAt = now();
      const report = await options.storage.collectGarbage();
      log(
        "info",
        `storage collection in ${now() - startedAt}ms: ${describe(report)}`,
      );
    } catch (error) {
      log(
        "error",
        `storage collection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void collect(), intervalMs);
  interval.unref?.();
  initialTimer = setTimeout(() => void collect(), initialDelayMs);
  initialTimer.unref?.();

  return () => {
    disposed = true;
    if (initialTimer !== undefined) clearTimeout(initialTimer);
    clearInterval(interval);
  };
}
