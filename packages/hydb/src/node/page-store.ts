import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";

export type RecordId = number;
export type RecordType = "page" | "commit" | "ref";

export type StoredRecord = Readonly<{
  id: RecordId;
  type: RecordType;
  payload: Uint8Array;
}>;

const magic = Buffer.from("HYDB");
const formatVersion = 1;
const checksumBytes = 16;
const headerBytes = 4 + 1 + 1 + 4 + checksumBytes;
const typeCode: Record<RecordType, number> = { page: 1, commit: 2, ref: 3 };
const codeType = new Map<number, RecordType>([
  [1, "page"],
  [2, "commit"],
  [3, "ref"],
]);

function checksum(payload: Uint8Array): Buffer {
  return createHash("sha256")
    .update(payload)
    .digest()
    .subarray(0, checksumBytes);
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

export class AppendOnlyPageStore {
  #end = 0;
  #closed = false;

  private constructor(private readonly file: FileHandle) {}

  static async open(path: string): Promise<AppendOnlyPageStore> {
    const store = new AppendOnlyPageStore(await open(path, "a+"));
    await store.recover();
    return store;
  }

  get endOffset(): number {
    return this.#end;
  }

  async append(type: RecordType, payload: Uint8Array): Promise<RecordId> {
    this.assertOpen();
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

  async *records(types?: ReadonlySet<RecordType>): AsyncIterable<StoredRecord> {
    this.assertOpen();
    let position = 0;
    while (position < this.#end) {
      const header = await this.readHeader(position, this.#end);
      if (header === undefined) break;
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

  private async recover(): Promise<void> {
    const size = Number((await this.file.stat()).size);
    let position = 0;
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
    const parsed = await this.readHeader(position, fileSize);
    if (parsed === undefined) return undefined;
    const { type, length, checksum: expectedChecksum } = parsed;
    const payload = Buffer.allocUnsafe(length);
    if (
      (await readInto(this.file, payload, position + headerBytes)) !== length
    ) {
      return undefined;
    }
    if (!checksum(payload).equals(expectedChecksum)) return undefined;
    return Object.freeze({ id: position, type, payload });
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
    if (!header.subarray(0, 4).equals(magic) || header[4] !== formatVersion) {
      return undefined;
    }
    const type = codeType.get(header[5]!);
    if (type === undefined) return undefined;
    const length = header.readUInt32BE(6);
    if (position + headerBytes + length > fileSize) return undefined;
    return { type, length, checksum: header.subarray(10) };
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Page store is closed");
  }
}
