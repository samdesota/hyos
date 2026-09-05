import assert from "node:assert/strict";
import test from "node:test";
import { selectedMode, supportsIncremental } from "./mode-selection.js";

test("mode selection defaults to incremental and honors persisted standard sessions", () => {
  for (const provider of ["glm", "codex"]) {
    assert.equal(selectedMode(provider), "incremental");
    assert.equal(selectedMode(provider, "standard"), "standard");
    assert.equal(
      selectedMode(provider, "standard", "incremental"),
      "incremental",
    );
    assert.equal(selectedMode(provider, "incremental", "standard"), "standard");
  }
});

test("providers without incremental support cannot receive it from the selector", () => {
  for (const provider of ["claude", ""]) {
    assert.equal(
      selectedMode(provider, "incremental", "incremental"),
      "standard",
    );
    assert.equal(supportsIncremental(provider), false);
  }
  assert.equal(supportsIncremental("glm"), true);
  assert.equal(supportsIncremental("codex"), true);
});
