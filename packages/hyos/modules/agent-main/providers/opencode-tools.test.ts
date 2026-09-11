import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import test from "node:test";

import { openCodeTool } from "./opencode-tools.js";

const execFileAsync = promisify(execFile);

test("aborting a bash command kills its child process tree", async () => {
  const controller = new AbortController();
  const bash = openCodeTool("bash");

  const pending = bash.execute(
    process.cwd(),
    {
      command: "sh -c 'sleep 30' & echo child-started; wait",
      timeout: 60_000,
      description: "Spawn a grandchild that inherits stdout",
    },
    controller.signal,
  );

  // Give the command time to start its grandchild, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();

  const started = Date.now();
  await assert.rejects(pending, /Cancelled/);
  const elapsed = Date.now() - started;

  // If only the top shell were signalled, the orphaned `sleep 30` would keep
  // the stdio pipes open and the promise would never settle.
  assert.ok(
    elapsed < 5_000,
    `aborted command settled in ${elapsed}ms, expected < 5000ms`,
  );

  // The whole tree must be gone, not just the top shell.
  const { stdout } = await execFileAsync("pgrep", ["-f", "sleep 30"]).catch(
    () => ({ stdout: "" }),
  );
  assert.equal(stdout.trim(), "", "sleep grandchild survived the abort");
});
