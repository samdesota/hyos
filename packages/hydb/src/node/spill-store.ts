import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  framedBytes,
  SpillCorruptionError,
  SpillLimitExceededError,
  type SpillRun,
  type SpillRunKind,
  type SpillSession,
  type SpillStats,
  type SpillStore,
} from "../spill.js";

type StoredRun = Readonly<{ run: SpillRun; path: string }>;

function checksum(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function frame(records: readonly Uint8Array[]): Uint8Array {
  const output = Buffer.allocUnsafe(framedBytes(records));
  let offset = 0;
  for (const record of records) {
    output.writeUInt32BE(record.byteLength, offset);
    offset += 4;
    Buffer.from(record).copy(output, offset);
    offset += record.byteLength;
    output.writeUInt32BE(checksum(record), offset);
    offset += 4;
  }
  return output;
}

async function readExact(
  file: FileHandle,
  buffer: Uint8Array,
  position: number,
): Promise<boolean> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await file.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (result.bytesRead === 0) return false;
    offset += result.bytesRead;
  }
  return true;
}

export async function nodeSpillStore(options: {
  directory: string;
  maxBytes: number;
}): Promise<SpillStore> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new TypeError("Spill maxBytes must be a non-negative safe integer");
  }
  await mkdir(options.directory, { recursive: true });
  let usedBytes = 0;
  let bytesWritten = 0;
  let bytesRead = 0;
  let closed = false;
  const sessions = new Set<SpillSession>();
  const allRuns = new Map<string, StoredRun>();

  const store: SpillStore = {
    async createSession({ owner, signal }) {
      if (closed) throw new Error("Spill store is closed");
      if (signal?.aborted) throw signal.reason;
      const sessionId = `${owner.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID()}`;
      const sessionDirectory = join(options.directory, sessionId);
      await mkdir(sessionDirectory);
      const runs = new Map<string, StoredRun>();
      let sessionClosed = false;
      let nextRun = 0;
      const assertOpen = (): void => {
        if (sessionClosed) throw new Error("Spill session is closed");
        if (signal?.aborted) throw signal.reason;
      };
      const session: SpillSession = {
        async writeRun(kind: SpillRunKind, records: readonly Uint8Array[]) {
          assertOpen();
          const payload = frame(records);
          const available = options.maxBytes - usedBytes;
          if (payload.byteLength > available) {
            throw new SpillLimitExceededError(
              payload.byteLength,
              Math.max(0, available),
            );
          }
          const id = `${sessionId}:${nextRun++}`;
          const path = join(sessionDirectory, `${nextRun}.run`);
          const temporary = `${path}.partial`;
          usedBytes += payload.byteLength;
          try {
            const file = await open(temporary, "wx");
            try {
              await file.writeFile(payload);
              await file.sync();
            } finally {
              await file.close();
            }
            await rename(temporary, path);
          } catch (error) {
            usedBytes -= payload.byteLength;
            await rm(temporary, { force: true });
            throw error;
          }
          const run = Object.freeze({
            id,
            kind,
            bytes: payload.byteLength,
            records: records.length,
          });
          const stored = Object.freeze({ run, path });
          runs.set(id, stored);
          allRuns.set(id, stored);
          bytesWritten += payload.byteLength;
          return run;
        },
        async *readRun(run) {
          assertOpen();
          const stored = runs.get(run.id);
          if (stored === undefined) throw new TypeError("Unknown spill run");
          const file = await open(stored.path, "r");
          let position = 0;
          try {
            for (let index = 0; index < run.records; index += 1) {
              assertOpen();
              const header = Buffer.allocUnsafe(4);
              if (!(await readExact(file, header, position))) {
                throw new SpillCorruptionError("Truncated spill record header");
              }
              position += 4;
              const length = header.readUInt32BE(0);
              const record = Buffer.allocUnsafe(length);
              if (!(await readExact(file, record, position))) {
                throw new SpillCorruptionError("Truncated spill record");
              }
              position += length;
              const trailer = Buffer.allocUnsafe(4);
              if (!(await readExact(file, trailer, position))) {
                throw new SpillCorruptionError("Truncated spill checksum");
              }
              position += 4;
              if (trailer.readUInt32BE(0) !== checksum(record)) {
                throw new SpillCorruptionError(
                  "Spill record checksum mismatch",
                );
              }
              yield record;
            }
            if (position !== run.bytes) {
              throw new SpillCorruptionError("Unexpected trailing spill data");
            }
            bytesRead += run.bytes;
          } finally {
            await file.close();
          }
        },
        async removeRun(run) {
          assertOpen();
          const stored = runs.get(run.id);
          if (stored === undefined) return;
          runs.delete(run.id);
          allRuns.delete(run.id);
          usedBytes -= stored.run.bytes;
          await rm(stored.path, { force: true });
        },
        async close() {
          if (sessionClosed) return;
          sessionClosed = true;
          for (const stored of runs.values()) {
            allRuns.delete(stored.run.id);
            usedBytes -= stored.run.bytes;
          }
          runs.clear();
          sessions.delete(session);
          await rm(sessionDirectory, { recursive: true, force: true });
        },
      };
      sessions.add(session);
      return session;
    },
    stats(): SpillStats {
      return Object.freeze({
        maxBytes: options.maxBytes,
        usedBytes,
        sessions: sessions.size,
        runs: allRuns.size,
        bytesWritten,
        bytesRead,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...sessions].map((session) => session.close()));
    },
  };
  return store;
}
