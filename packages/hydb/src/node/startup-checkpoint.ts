import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";

export type StartupCheckpoint = {
  offset: number;
  branches: [string, { head: string; sequence: number; base: string }][];
  commits: [string, number][];
  metadata: {
    format: 2;
    retention: unknown;
    retains: Record<string, string>;
    historyFloors: Record<string, number>;
  };
};
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

async function identity(path: string, offset: number) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!Number.isSafeInteger(offset) || offset < 26 || offset > stat.size)
      throw new Error("Invalid checkpoint offset");
    const bytes = Buffer.alloc(Math.min(offset, 128));
    await file.read(bytes, 0, bytes.length, offset - bytes.length);
    return { ino: stat.ino, dev: stat.dev, boundary: digest(bytes) };
  } finally {
    await file.close();
  }
}

export async function readStartupCheckpoint(
  path: string,
): Promise<StartupCheckpoint | undefined> {
  try {
    const envelope = JSON.parse(await readFile(`${path}.checkpoint`, "utf8"));
    if (
      envelope.version !== 1 ||
      digest(envelope.payload) !== envelope.checksum
    )
      return;
    const checkpoint: StartupCheckpoint = JSON.parse(envelope.payload);
    if (
      JSON.stringify(await identity(path, checkpoint.offset)) !==
      JSON.stringify(envelope.identity)
    )
      return;
    if (
      !Array.isArray(checkpoint.commits) ||
      !checkpoint.commits.every(
        ([id, offset]) =>
          typeof id === "string" &&
          Number.isSafeInteger(offset) &&
          offset >= 0 &&
          offset < checkpoint.offset,
      )
    )
      return;
    if (!Array.isArray(checkpoint.branches) || checkpoint.metadata.format !== 2)
      return;
    return checkpoint;
  } catch {
    return;
  }
}

export async function writeStartupCheckpoint(
  path: string,
  checkpoint: StartupCheckpoint,
): Promise<void> {
  const temporary = `${path}.checkpoint-${randomUUID()}`;
  const trace = (event: string) => {
    if (process.env.HYOS_BOOT_TRACE === "1")
      console.log(`[DEBUG-boot-7f2c] checkpoint-file ${event}`);
  };
  try {
    trace("serialize:start");
    const payload = JSON.stringify(checkpoint);
    trace(`serialize:done bytes=${Buffer.byteLength(payload)}`);
    trace("identity:start");
    const fileIdentity = await identity(path, checkpoint.offset);
    trace("identity:done");
    trace("write:start");
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        payload,
        checksum: digest(payload),
        identity: fileIdentity,
      }),
      { flag: "wx", mode: 0o600 },
    );
    trace("write:done");
    const file = await open(temporary, "r+");
    try {
      trace("sidecar-sync:start");
      await file.sync();
      trace("sidecar-sync:done");
    } finally {
      await file.close();
    }
    trace("rename:start");
    await rename(temporary, `${path}.checkpoint`);
    trace("rename:done");
  } finally {
    trace("cleanup:start");
    await rm(temporary, { force: true });
    trace("cleanup:done");
  }
}
