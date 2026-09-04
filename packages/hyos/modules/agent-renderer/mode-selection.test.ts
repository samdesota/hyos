import assert from "node:assert/strict";
import test from "node:test";
import { selectedMode } from "./mode-selection.js";

test("mode selection defaults to incremental and honors persisted standard sessions", () => {
  assert.equal(selectedMode("glm"), "incremental");
  assert.equal(selectedMode("glm", "standard"), "standard");
  assert.equal(selectedMode("glm", "standard", "incremental"), "incremental");
  assert.equal(selectedMode("glm", "incremental", "standard"), "standard");
});

test("non-GLM providers cannot receive incremental mode from the selector", () => {
  for (const provider of ["claude", "codex", ""]) {
    assert.equal(
      selectedMode(provider, "incremental", "incremental"),
      "standard",
    );
  }
});
