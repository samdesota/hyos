import assert from "node:assert/strict";
import test from "node:test";

import { replaceModernColorFunctions } from "../src/browser/normalize-colors.js";

test("replaces modern color functions inside computed CSS values", () => {
  const converted: string[] = [];
  const value = replaceModernColorFunctions(
    "0 1px 2px oklab(0.5 0.1 0.2 / 0.4), inset 0 0 0 color-mix(in oklab, red 20%, blue)",
    (color) => {
      converted.push(color);
      return color.startsWith("oklab(")
        ? "rgba(120, 80, 40, 0.4)"
        : "rgb(90, 0, 170)";
    },
  );

  assert.equal(
    value,
    "0 1px 2px rgba(120, 80, 40, 0.4), inset 0 0 0 rgb(90, 0, 170)",
  );
  assert.deepEqual(converted, [
    "oklab(0.5 0.1 0.2 / 0.4)",
    "color-mix(in oklab, red 20%, blue)",
  ]);
});
