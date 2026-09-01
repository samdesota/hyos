import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_BUFFER = 200_000;
const MAX_READ = 30_000;

export interface BackgroundCommandSnapshot {
  processId: string;
  status: "running" | "exited" | "failed";
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface ProcessEntry {
  owner: string;
  child: ChildProcessWithoutNullStreams;
  status: BackgroundCommandSnapshot["status"];
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  waiters: Set<() => void>;
}

export interface BackgroundCommandManager {
  start(
    owner: string,
    cwd: string,
    command: string,
    args: readonly string[],
  ): Promise<BackgroundCommandSnapshot>;
  read(
    owner: string,
    processId: string,
    waitMs?: number,
  ): Promise<BackgroundCommandSnapshot>;
  write(
    owner: string,
    processId: string,
    input: string,
    closeStdin?: boolean,
  ): Promise<BackgroundCommandSnapshot>;
  stop(owner: string, processId: string): Promise<BackgroundCommandSnapshot>;
  stopOwner(owner: string): Promise<void>;
}

function appendBuffer(
  entry: ProcessEntry,
  stream: "stdout" | "stderr",
  chunk: Buffer,
): void {
  entry[stream] += chunk.toString();
  if (entry[stream].length > MAX_BUFFER) {
    entry[stream] = entry[stream].slice(-MAX_BUFFER);
    entry[`${stream}Truncated`] = true;
  }
  for (const notify of entry.waiters) notify();
  entry.waiters.clear();
}

function terminate(entry: ProcessEntry, signal: NodeJS.Signals): void {
  const pid = entry.child.pid;
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process groups are unavailable.
    }
  }
  entry.child.kill(signal);
}

export function createBackgroundCommandManager(): BackgroundCommandManager {
  const processes = new Map<string, ProcessEntry>();

  function owned(owner: string, processId: string): ProcessEntry {
    const entry = processes.get(processId);
    if (!entry || entry.owner !== owner) {
      throw new Error(`Unknown background process: ${processId}`);
    }
    return entry;
  }

  function snapshot(
    processId: string,
    entry: ProcessEntry,
  ): BackgroundCommandSnapshot {
    const stdout = entry.stdout.slice(0, MAX_READ);
    const stderr = entry.stderr.slice(0, MAX_READ);
    entry.stdout = entry.stdout.slice(stdout.length);
    entry.stderr = entry.stderr.slice(stderr.length);
    const stdoutTruncated = entry.stdoutTruncated;
    const stderrTruncated = entry.stderrTruncated;
    entry.stdoutTruncated = false;
    entry.stderrTruncated = false;
    return {
      processId,
      status: entry.status,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      exitCode: entry.exitCode,
      signal: entry.signal,
    };
  }

  async function waitForOutput(entry: ProcessEntry, waitMs: number) {
    if (
      entry.status !== "running" ||
      entry.stdout.length > 0 ||
      entry.stderr.length > 0 ||
      waitMs <= 0
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(waitMs, 30_000));
      function done() {
        clearTimeout(timer);
        entry.waiters.delete(done);
        resolve();
      }
      entry.waiters.add(done);
    });
  }

  async function stopEntry(processId: string, entry: ProcessEntry) {
    if (entry.status === "running") {
      const closed = new Promise<void>((resolve) => {
        entry.child.once("close", () => resolve());
      });
      terminate(entry, "SIGTERM");
      await Promise.race([
        closed,
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (entry.status === "running") {
        terminate(entry, "SIGKILL");
        await Promise.race([
          closed,
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
    }
    return snapshot(processId, entry);
  }

  return {
    async start(owner, cwd, command, args) {
      const processId = randomUUID();
      const child = spawn(command, [...args], {
        cwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const entry: ProcessEntry = {
        owner,
        child,
        status: "running",
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: null,
        signal: null,
        waiters: new Set(),
      };
      processes.set(processId, entry);
      child.stdout.on("data", (chunk: Buffer) =>
        appendBuffer(entry, "stdout", chunk),
      );
      child.stderr.on("data", (chunk: Buffer) =>
        appendBuffer(entry, "stderr", chunk),
      );
      child.on("close", (exitCode, signal) => {
        if (entry.status !== "failed") entry.status = "exited";
        entry.exitCode = exitCode;
        entry.signal = signal;
        for (const notify of entry.waiters) notify();
        entry.waiters.clear();
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }).catch((error) => {
        processes.delete(processId);
        throw error;
      });
      child.on("error", (error) => {
        entry.status = "failed";
        entry.stderr += `${error.message}\n`;
        for (const notify of entry.waiters) notify();
        entry.waiters.clear();
      });
      return snapshot(processId, entry);
    },
    async read(owner, processId, waitMs = 0) {
      const entry = owned(owner, processId);
      await waitForOutput(entry, waitMs);
      return snapshot(processId, entry);
    },
    async write(owner, processId, input, closeStdin = false) {
      const entry = owned(owner, processId);
      if (entry.status !== "running" || !entry.child.stdin.writable) {
        throw new Error(
          `Background process is not accepting stdin: ${processId}`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        entry.child.stdin.write(input, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      if (closeStdin) entry.child.stdin.end();
      return snapshot(processId, entry);
    },
    async stop(owner, processId) {
      return stopEntry(processId, owned(owner, processId));
    },
    async stopOwner(owner) {
      await Promise.all(
        [...processes]
          .filter(([, entry]) => entry.owner === owner)
          .map(async ([processId, entry]) => {
            await stopEntry(processId, entry);
            processes.delete(processId);
          }),
      );
    },
  };
}
