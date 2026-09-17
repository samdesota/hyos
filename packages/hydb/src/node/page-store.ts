import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { PageId, TreePageStore } from "./tree-page-store.js";

export type RecordId = number;
export type RecordType = "page" | "commit" | "ref" | "meta";

export type StoredRecord = Readonly<{
  id: RecordId;
  type: RecordType;
  payload: Uint8Array;
}>;

const magic = Buffer.from("HYDB");
const formatVersion = 1;
const checksumBytes = 16;
const headerBytes = 4 + 1 + 1 + 4 + checksumBytes;
const typeCode: Record<RecordType, number> = {
  page: 1,
  commit: 2,
  ref: 3,
  meta: 4,
};
const codeType = new Map<number, RecordType>([
  [1, "page"],
  [2, "commit"],
  [3, "ref"],
  [4, "meta"],
]);

function checksum(payload: Uint8Array): Buffer {
  return createHash("sha256")
    .update(payload)
    .digest()
    .subarray(0, checksumBytes);
}

// Reads up to this many bytes in one shot hoping to capture header + payload.
const readProbeBytes = 64 * 1024;

function parseHeader(
  header: Buffer,
  position: number,
  fileSize: number,
): { type: RecordType; length: number; checksum: Uint8Array } | undefined {
  if (!header.subarray(0, 4).equals(magic) || header[4] !== formatVersion) {
    return undefined;
  }
  const type = codeType.get(header[5]!);
  if (type === undefined) return undefined;
  const length = header.readUInt32BE(6);
  if (position + headerBytes + length > fileSize) return undefined;
  return { type, length, checksum: header.subarray(10) };
}

async function readInto(
  file: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<number> {
  let total = 0;
  while (total < buffer.length) {
    const result = await file.read(
      buffer,
      total,
      buffer.length - total,
      position + total,
    );
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
  }
  return total;
}

async function writeAll(
  file: FileHandle,
  buffer: Uint8Array,
  position: number,
): Promise<void> {
  let total = 0;
  while (total < buffer.byteLength) {
    const result = await file.write(
      buffer,
      total,
      buffer.byteLength - total,
      position + total,
    );
    if (result.bytesWritten === 0) throw new Error("Short storage write");
    total += result.bytesWritten;
  }
}

export class AppendOnlyPageStore implements TreePageStore {
  #end = 0;
  #closed = false;

  private constructor(
    private readonly file: FileHandle,
    private readonly readOnly = false,
  ) {}

  static async open(
    path: string,
    recoveredOffset = 0,
  ): Promise<AppendOnlyPageStore> {
    const store = new AppendOnlyPageStore(await open(path, "a+"));
    try {
      await store.recover(recoveredOffset);
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  /** Strict read-only reader: never recovers/truncates a damaged source. */
  static async openReadOnly(path: string): Promise<AppendOnlyPageStore> {
    const store = new AppendOnlyPageStore(await open(path, "r"), true);
    try {
      store.#end = (await store.file.stat()).size;
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  get endOffset(): number {
    return this.#end;
  }

  async readPage(id: PageId): Promise<Uint8Array> {
    return (await this.read(id, "page")).payload;
  }

  writePage(payload: Uint8Array): Promise<PageId> {
    return this.append("page", payload);
  }

  async append(type: RecordType, payload: Uint8Array): Promise<RecordId> {
    this.assertOpen();
    if (this.readOnly) throw new Error("Page store is read-only");
    if (payload.byteLength > 0xffff_ffff) {
      throw new RangeError("Storage record exceeds 4 GiB");
    }
    const header = Buffer.allocUnsafe(headerBytes);
    magic.copy(header, 0);
    header[4] = formatVersion;
    header[5] = typeCode[type];
    header.writeUInt32BE(payload.byteLength, 6);
    checksum(payload).copy(header, 10);
    const id = this.#end;
    await writeAll(this.file, header, id);
    await writeAll(this.file, payload, id + headerBytes);
    this.#end += headerBytes + payload.byteLength;
    return id;
  }

  async read(id: RecordId, expectedType?: RecordType): Promise<StoredRecord> {
    this.assertOpen();
    const record = await this.readRecord(id);
    if (record === undefined)
      throw new Error(`Missing storage record at ${id}`);
    if (expectedType !== undefined && record.type !== expectedType) {
      throw new Error(
        `Storage record at ${id} is ${record.type}, expected ${expectedType}`,
      );
    }
    return record;
  }

  async *records(
    types?: ReadonlySet<RecordType>,
    start = 0,
  ): AsyncIterable<StoredRecord> {
    this.assertOpen();
    let position = start;
    while (position < this.#end) {
      const header = await this.readHeader(position, this.#end);
      if (header === undefined)
        throw new Error(`Corrupt storage header at ${position}`);
      if (types === undefined || types.has(header.type)) {
        const record = await this.readRecord(position);
        if (record === undefined)
          throw new Error(`Corrupt storage record at ${position}`);
        yield record;
      }
      position += headerBytes + header.length;
    }
  }

  async sync(): Promise<void> {
    this.assertOpen();
    await this.file.sync();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.file.close();
  }

  private async recover(start: number): Promise<void> {
    const size = Number((await this.file.stat()).size);
    if (!Number.isSafeInteger(start) || start < 0 || start > size) {
      throw new RangeError("Invalid recovered offset");
    }
    let position = start;
    while (position < size) {
      const header = await this.readHeader(position, size);
      if (header === undefined) break;
      position += headerBytes + header.length;
    }
    this.#end = position;
    if (position !== size) await this.file.truncate(position);
  }

  private async readRecord(
    position: number,
    fileSize = this.#end,
  ): Promise<StoredRecord | undefined> {
    // Most records are small; a single read of header + payload prefix avoids
    // one syscall and await round-trip per record on every cold scan.
    const probeBytes = Math.min(readProbeBytes, fileSize - position);
    if (probeBytes >= headerBytes) {
      const probe = Buffer.allocUnsafe(probeBytes);
      const read = await readInto(this.file, probe, position);
      if (read >= headerBytes) {
        const parsed = parseHeader(
          probe.subarray(0, headerBytes),
          position,
          fileSize,
        );
        if (parsed !== undefined && read >= headerBytes + parsed.length) {
          const payload = probe.subarray(
            headerBytes,
            headerBytes + parsed.length,
          );
          if (!checksum(payload).equals(parsed.checksum)) return undefined;
          return Object.freeze({ id: position, type: parsed.type, payload });
        }
      }
    }
    // Fallback for large or truncated-at-edge records: header, then payload.
    const parsed = await this.readHeader(position, fileSize);
    if (parsed === undefined) return undefined;
    const payload = Buffer.allocUnsafe(parsed.length);
    if (
      (await readInto(this.file, payload, position + headerBytes)) !==
      parsed.length
    ) {
      return undefined;
    }
    if (!checksum(payload).equals(parsed.checksum)) return undefined;
    return Object.freeze({ id: position, type: parsed.type, payload });
  }

  private async readHeader(
    position: number,
    fileSize: number,
  ): Promise<
    { type: RecordType; length: number; checksum: Uint8Array } | undefined
  > {
    if (position < 0 || position + headerBytes > fileSize) return undefined;
    const header = Buffer.allocUnsafe(headerBytes);
    if ((await readInto(this.file, header, position)) !== headerBytes) {
      return undefined;
    }
    return parseHeader(header, position, fileSize);
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Page store is closed");
  }
}
