import { execFile } from "node:child_process";
import { promisify } from "node:util";

import assert from "node:assert/strict";
import test from "node:test";

import { resolveRgBinary } from "./ripgrep.js";

const execFileAsync = promisify(execFile);

test("resolveRgBinary returns an executable ripgrep binary", async () => {
  const rg = await resolveRgBinary();
  assert.ok(rg.length > 0);

  // The bundled path should point at a real binary; "rg" (PATH fallback)
  // still resolves through the shell, so execFile works for both.
  const { stdout } = await execFileAsync(rg, ["--version"]);
  assert.match(stdout, /^ripgrep /);
});
