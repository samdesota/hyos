import type { StorageKey } from "../storage.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeNumber(value: number): Uint8Array {
  if (!Number.isFinite(value)) {
    throw new TypeError("Storage keys require finite numbers");
  }
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(Object.is(value, -0) ? 0 : value);
  if ((bytes[0]! & 0x80) !== 0) {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = bytes[index]! ^ 0xff;
    }
  } else {
    bytes[0] = bytes[0]! ^ 0x80;
  }
  return bytes;
}

function encodeDate(value: Date): Uint8Array {
  const time = value.getTime();
  if (!Number.isFinite(time)) throw new TypeError("Invalid date storage key");
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigInt64BE(BigInt(time));
  bytes[0] = bytes[0]! ^ 0x80;
  return bytes;
}

function encodeString(value: string): Uint8Array {
  const input = textEncoder.encode(value);
  const output: number[] = [];
  for (const byte of input) {
    if (byte === 0) output.push(0, 0xff);
    else output.push(byte);
  }
  output.push(0, 0);
  return Uint8Array.from(output);
}

export function encodeOrderedKey(key: StorageKey): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of key) {
    if (part === null) chunks.push(Uint8Array.of(0x10));
    else if (part === false) chunks.push(Uint8Array.of(0x20));
    else if (part === true) chunks.push(Uint8Array.of(0x21));
    else if (typeof part === "number") {
      chunks.push(Uint8Array.of(0x30), encodeNumber(part));
    } else if (part instanceof Date) {
      chunks.push(Uint8Array.of(0x40), encodeDate(part));
    } else if (typeof part === "string") {
      chunks.push(Uint8Array.of(0x50), encodeString(part));
    } else {
      throw new TypeError(`Unsupported storage key value: ${String(part)}`);
    }
  }
  return Buffer.concat(chunks);
}

export function keyPrefixUpperBound(prefix: Uint8Array): Uint8Array {
  return Buffer.concat([prefix, Uint8Array.of(0xff)]);
}

type EncodedValue =
  | null
  | boolean
  | number
  | string
  | readonly EncodedValue[]
  | { readonly $hydb: "date"; readonly value: number }
  | { readonly [key: string]: EncodedValue };

function toEncoded(value: unknown): EncodedValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Cannot persist non-finite number");
    return value;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time))
      throw new TypeError("Cannot persist invalid date");
    return { $hydb: "date", value: time };
  }
  if (Array.isArray(value)) return value.map(toEncoded);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, toEncoded(nested)]),
    );
  }
  throw new TypeError(`Cannot persist value: ${String(value)}`);
}

function fromEncoded(value: EncodedValue): unknown {
  if (Array.isArray(value)) return value.map(fromEncoded);
  if (typeof value === "object" && value !== null) {
    if ("$hydb" in value && value.$hydb === "date") {
      return new Date(value.value as number);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        fromEncoded(nested as EncodedValue),
      ]),
    );
  }
  return value;
}

export function encodeValue(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(toEncoded(value)));
}

export function decodeValue(bytes: Uint8Array): unknown {
  return fromEncoded(JSON.parse(textDecoder.decode(bytes)) as EncodedValue);
}
