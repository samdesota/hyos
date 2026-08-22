const dateTag = "$hyapp.date";

type WireValue =
  | null
  | boolean
  | number
  | string
  | readonly WireValue[]
  | { readonly [key: string]: WireValue };

function encode(value: unknown): WireValue {
  if (value instanceof Date) return { [dateTag]: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encode(item)]),
    );
  }
  return value as null | boolean | number | string;
}

function decode(value: WireValue): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    if (Object.keys(value).length === 1 && dateTag in value) {
      return new Date(value[dateTag] as string);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decode(item)]),
    );
  }
  return value;
}

export function stringifyWire(value: unknown): string {
  return JSON.stringify(encode(value));
}

export function parseWire(value: string): unknown {
  return decode(JSON.parse(value) as WireValue);
}
