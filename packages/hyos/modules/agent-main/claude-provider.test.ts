import assert from "node:assert/strict";
import test from "node:test";

import { claudeToolCategory } from "./providers/claude.js";

test("Claude Bash read batches are presented as file reads", () => {
  assert.equal(
    claudeToolCategory("Bash", {
      command: "cat package.json && find src -type f",
      description: "Read config and list source files",
    }),
    "read",
  );
  assert.equal(
    claudeToolCategory("Bash", {
      command: "npm test",
      description: "Run the test suite",
    }),
    "command",
  );
});
