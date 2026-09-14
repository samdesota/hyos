import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = Readonly<{
  ts: string;
  level: LogLevel;
  source: string;
  msg: string;
}>;

export type LogSink = Readonly<{
  path: string;
  log(level: LogLevel, source: string, msg: string): void;
}>;

export type LogSinkOptions = Readonly<{
  directory: string;
  fileName?: string;
  maxBytes?: number;
  keepFiles?: number;
  now?: () => Date;
}>;

export const defaultLogFileName = "hyos.log";
export const defaultMaxBytes = 5 * 1024 * 1024;
export const defaultKeepFiles = 3;

/**
 * JSONL file sink: one JSON object per line, appended synchronously so lines
 * are atomic at line granularity and ordered even under interleaved callers.
 * Rotation is size-based: `hyos.log` -> `hyos.log.1` -> ... keeping the newest
 * `keepFiles` rotated files.
 */
export function createLogSink(options: LogSinkOptions): LogSink {
  const fileName = options.fileName ?? defaultLogFileName;
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const keepFiles = options.keepFiles ?? defaultKeepFiles;
  const now = options.now ?? (() => new Date());
  const file = path.join(options.directory, fileName);
  mkdirSync(options.directory, { recursive: true });
  appendFileSync(file, "");

  const rotate = (): void => {
    // Oldest rotated file falls off the end.
    const oldest = `${file}.${keepFiles - 1}`;
    if (keepFiles > 1 && existsSync(oldest)) unlinkSync(oldest);
    for (let i = keepFiles - 2; i >= 1; i -= 1) {
      const from = `${file}.${i}`;
      if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  };

  const log = (level: LogLevel, source: string, msg: string): void => {
    const entry: LogEntry = {
      ts: now().toISOString(),
      level,
      source,
      msg: typeof msg === "string" ? msg : String(msg),
    };
    try {
      if (statSync(file).size + lineSize(entry) > maxBytes) rotate();
    } catch {
      // Rotation is best-effort; keep appending if stat fails.
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  };

  return { path: file, log };
}

/**
 * Route a hyos-owned view's `console-message` events into the sink. Browser
 * tab views must never be passed here: their page logs stay out of the file.
 * Handles both the modern event-object signature (Electron >= 35) and the
 * legacy positional one.
 */
export function attachViewConsoleLogging(
  sink: LogSink,
  contents: WebContents,
  source: string,
): () => void {
  const onConsoleMessage = (
    event: { level?: unknown; message?: unknown },
    legacyLevel?: number,
    legacyMessage?: string,
  ): void => {
    const rawLevel = event?.level ?? legacyLevel;
    const message = event?.message ?? legacyMessage ?? "";
    const level = normalizeLevel(rawLevel);
    sink.log(
      level,
      source,
      typeof message === "string" ? message : String(message),
    );
  };
  contents.on("console-message", onConsoleMessage);
  return () => {
    contents.off("console-message", onConsoleMessage);
  };
}

const levelNames: Record<number, LogLevel> = {
  0: "debug",
  1: "info",
  2: "warn",
  3: "error",
};

function normalizeLevel(raw: unknown): LogLevel {
  if (typeof raw === "number") return levelNames[raw] ?? "info";
  if (raw === "verbose" || raw === "debug") return "debug";
  if (raw === "warning") return "warn";
  if (raw === "error") return "error";
  return "info";
}

const lineSize = (entry: LogEntry): number => JSON.stringify(entry).length + 1;
