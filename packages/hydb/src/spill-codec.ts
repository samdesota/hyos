type EncodedValue =
  | null
  | boolean
  | string
  | number
  | Readonly<{ t: "undefined" }>
  | Readonly<{ t: "number"; v: string }>
  | Readonly<{ t: "bigint"; v: string }>
  | Readonly<{ t: "date"; v: string }>
  | Readonly<{ t: "bytes"; v: string }>
  | Readonly<{ t: "array"; v: readonly EncodedValue[] }>
  | Readonly<{
      t: "object";
      v: readonly (readonly [string, EncodedValue])[];
    }>;

const base64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += base64[first >>> 2]!;
    result += base64[((first & 3) << 4) | ((second ?? 0) >>> 4)]!;
    result +=
      second === undefined
        ? "="
        : base64[((second & 15) << 2) | ((third ?? 0) >>> 6)]!;
    result += third === undefined ? "=" : base64[third & 63]!;
  }
  return result;
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0) throw new TypeError("Invalid base64 spill value");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = base64.indexOf(value[index]!);
    const b = base64.indexOf(value[index + 1]!);
    const c = value[index + 2] === "=" ? 0 : base64.indexOf(value[index + 2]!);
    const d = value[index + 3] === "=" ? 0 : base64.indexOf(value[index + 3]!);
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new TypeError("Invalid base64 spill value");
    }
    if (offset < output.length) output[offset++] = (a << 2) | (b >>> 4);
    if (offset < output.length) output[offset++] = (b << 4) | (c >>> 2);
    if (offset < output.length) output[offset++] = (c << 6) | d;
  }
  return output;
}

function encodeValue(value: unknown, seen: WeakSet<object>): EncodedValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "undefined") return { t: "undefined" };
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    return { t: "number", v: String(value) };
  }
  if (typeof value === "bigint") return { t: "bigint", v: String(value) };
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported spill value: ${typeof value}`);
  }
  if (seen.has(value))
    throw new TypeError("Spill values cannot contain cycles");
  seen.add(value);
  try {
    if (value instanceof Date) return { t: "date", v: value.toISOString() };
    if (value instanceof Uint8Array) {
      return { t: "bytes", v: encodeBase64(value) };
    }
    if (Array.isArray(value)) {
      return { t: "array", v: value.map((item) => encodeValue(item, seen)) };
    }
    return {
      t: "object",
      v: Object.entries(value).map(([key, item]) => [
        key,
        encodeValue(item, seen),
      ]),
    };
  } finally {
    seen.delete(value);
  }
}

function decodeValue(value: EncodedValue): unknown {
  if (value === null || typeof value !== "object") return value;
  switch (value.t) {
    case "undefined":
      return undefined;
    case "number":
      if (value.v === "NaN") return Number.NaN;
      if (value.v === "Infinity") return Number.POSITIVE_INFINITY;
      if (value.v === "-Infinity") return Number.NEGATIVE_INFINITY;
      return -0;
    case "bigint":
      return BigInt(value.v);
    case "date":
      return new Date(value.v);
    case "bytes":
      return decodeBase64(value.v);
    case "array":
      return value.v.map(decodeValue);
    case "object":
      return Object.fromEntries(
        value.v.map(([key, item]) => [key, decodeValue(item)]),
      );
  }
}

export function encodeSpillValue(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(encodeValue(value, new WeakSet())),
  );
}

export function decodeSpillValue(bytes: Uint8Array): unknown {
  return decodeValue(
    JSON.parse(new TextDecoder().decode(bytes)) as EncodedValue,
  );
}
