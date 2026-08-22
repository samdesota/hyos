import assert from "node:assert/strict";
import test from "node:test";

import { parseWire, stringifyWire } from "../src/wire.js";

test("wire values round-trip database and command scalar types", () => {
  const value = {
    date: new Date("2026-08-22T12:00:00.000Z"),
    missing: undefined,
    bytes: new Uint8Array([0, 127, 255]),
    bigint: 9007199254740993n,
    numbers: [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0,
    ],
    collision: { $hyapp: ["date", "not-a-protocol-value"] },
  };

  const decoded = parseWire(stringifyWire(value)) as typeof value;
  assert.deepEqual(decoded, value);
  assert.ok(Object.is(decoded.numbers[0], Number.NaN));
  assert.ok(Object.is(decoded.numbers[3], -0));
});

test("wire decoding fails closed on unknown tags", () => {
  assert.throws(
    () => parseWire('{"$hyapp":["future-protocol"]}'),
    /Unknown wire tag/,
  );
});
