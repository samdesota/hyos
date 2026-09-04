import assert from "node:assert/strict";
import test from "node:test";
import { selectedMode } from "./mode-selection.js";

test("mode selection defaults to standard and restores persisted incremental sessions", () => {
  assert.equal(selectedMode("glm"), "standard");
  assert.equal(selectedMode("glm", "incremental"), "incremental");
  assert.equal(selectedMode("glm", "incremental", "standard"), "standard");
  assert.equal(selectedMode("glm", "standard", "incremental"), "incremental");
});

test("non-GLM providers cannot receive incremental mode from the selector", () => {
  for (const provider of ["claude", "codex", ""]) {
    assert.equal(
      selectedMode(provider, "incremental", "incremental"),
      "standard",
    );
  }
});
