const wireTag = "$hyapp";

type WireScalar = null | boolean | number | string;
export type WireValue =
  WireScalar | readonly WireValue[] | { readonly [key: string]: WireValue };

type TaggedValue = readonly [tag: string, value?: WireValue];

function tagged(tag: string, value?: WireValue): WireValue {
  return { [wireTag]: value === undefined ? [tag] : [tag, value] };
}

export function encodeWireValue(value: unknown): WireValue {
  if (value === undefined) return tagged("undefined");
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new TypeError("Cannot encode an invalid Date");
    return tagged("date", value.toISOString());
  }
  if (value instanceof Uint8Array) {
    return tagged("bytes", Array.from(value));
  }
  if (typeof value === "bigint") return tagged("bigint", value.toString());
  if (typeof value === "number" && !Number.isFinite(value)) {
    return tagged("number", String(value));
  }
  if (typeof value === "number" && Object.is(value, -0)) {
    return tagged("number", "-0");
  }
  if (Array.isArray(value)) return value.map(encodeWireValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, item]) => [key, encodeWireValue(item)] as const,
    );
    if (Object.hasOwn(value, wireTag)) {
      return tagged("object", entries as unknown as WireValue);
    }
    return Object.fromEntries(entries);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  throw new TypeError(`Unsupported wire value: ${typeof value}`);
}

function decodeTag(value: TaggedValue): unknown {
  const [tag, payload] = value;
  switch (tag) {
    case "undefined":
      return undefined;
    case "date": {
      if (typeof payload !== "string") throw new TypeError("Invalid wire Date");
      const date = new Date(payload);
      if (Number.isNaN(date.getTime()))
        throw new TypeError("Invalid wire Date");
      return date;
    }
    case "bytes":
      if (
        !Array.isArray(payload) ||
        !payload.every(
          (item) =>
            Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255,
        )
      ) {
        throw new TypeError("Invalid wire bytes");
      }
      return new Uint8Array(payload as number[]);
    case "bigint":
      if (typeof payload !== "string")
        throw new TypeError("Invalid wire bigint");
      return BigInt(payload);
    case "number":
      if (payload === "NaN") return Number.NaN;
      if (payload === "Infinity") return Number.POSITIVE_INFINITY;
      if (payload === "-Infinity") return Number.NEGATIVE_INFINITY;
      if (payload === "-0") return -0;
      throw new TypeError("Invalid special wire number");
    case "object":
      if (
        !Array.isArray(payload) ||
        !payload.every(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string",
        )
      ) {
        throw new TypeError("Invalid escaped wire object");
      }
      return Object.fromEntries(
        payload.map((entry) => [
          entry[0] as string,
          decodeWireValue(entry[1] as WireValue),
        ]),
      );
    default:
      throw new TypeError(`Unknown wire tag: ${tag}`);
  }
}

export function decodeWireValue(value: WireValue): unknown {
  if (Array.isArray(value)) return value.map(decodeWireValue);
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, WireValue>>;
    if (Object.hasOwn(record, wireTag)) {
      const tag = record[wireTag];
      if (!Array.isArray(tag) || typeof tag[0] !== "string") {
        throw new TypeError("Invalid tagged wire value");
      }
      return decodeTag(tag as unknown as TaggedValue);
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, decodeWireValue(item)]),
    );
  }
  return value;
}

export function stringifyWire(value: unknown): string {
  return JSON.stringify(encodeWireValue(value));
}

export function parseWire(value: string): unknown {
  return decodeWireValue(JSON.parse(value) as WireValue);
}
