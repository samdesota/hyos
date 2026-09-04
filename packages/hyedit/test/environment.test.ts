import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadNearestHyeditEnvironment } from "../src/environment.js";

test("loads the nearest parent .env for non-Vite hosts", () => {
  const root = mkdtempSync(join(tmpdir(), "hyedit-env-"));
  const project = join(root, "packages", "app");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(root, ".env"),
    "AI_GATEWAY_API_KEY=test-key\nHYEDIT_MODEL=test/model\n",
  );
  try {
    assert.deepEqual(loadNearestHyeditEnvironment(project), {
      AI_GATEWAY_API_KEY: "test-key",
      HYEDIT_MODEL: "test/model",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
