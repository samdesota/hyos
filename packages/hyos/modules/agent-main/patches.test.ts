import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  claudeCompletionInstruction,
  claudePatchChanges,
  contentDiff,
  createPatchActivity,
  promptWithPatchContract,
  requirePatchExplanation,
} from "./providers/patches.js";

const execFileAsync = promisify(execFile);

test("patch explanations are mandatory", () => {
  assert.throws(
    () =>
      requirePatchExplanation("  ", [{ path: "src/app.ts", kind: "update" }]),
    /without first explaining the patch/,
  );
  assert.equal(
    requirePatchExplanation("  Keep the session state in sync.  ", []),
    "Keep the session state in sync.",
  );
});

test("provider prompts carry the patch contract", () => {
  const prompt = promptWithPatchContract("Build the feature.");
  assert.match(prompt, /Before every file-changing tool call/);
  assert.match(prompt, /User request:\nBuild the feature\./);
});

test("Claude completion requires verified whole-task completion", () => {
  assert.match(claudeCompletionInstruction, /entire user request/);
  assert.match(claudeCompletionInstruction, /call Complete/);
  assert.match(claudeCompletionInstruction, /not call Complete for a partial/);
});

test("Claude edit inputs normalize to provider-neutral changes", () => {
  assert.deepEqual(
    claudePatchChanges("Edit", { file_path: "/project/app.ts" }),
    [{ path: "/project/app.ts", kind: "update" }],
  );
});

test("aliased Claude Edit and Write inputs normalize to patch changes", () => {
  assert.deepEqual(
    claudePatchChanges("mcp__hyos__Write", {
      file_path: "/project/src/dataflow/keys.ts",
    }),
    [{ path: "/project/src/dataflow/keys.ts", kind: "write" }],
  );
  assert.deepEqual(
    claudePatchChanges("mcp__hyos__Edit", { file_path: "/project/app.ts" }),
    [{ path: "/project/app.ts", kind: "update" }],
  );
});

test("contentDiff builds a per-edit unified diff with four context lines", () => {
  const before = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  const after = [...before];
  after[5] = "line six changed";
  const diff = contentDiff(
    "src/example.ts",
    `${before.join("\n")}\n`,
    `${after.join("\n")}\n`,
  );

  assert.match(diff, /^diff --git a\/src\/example\.ts b\/src\/example\.ts$/m);
  assert.match(diff, /^--- a\/src\/example\.ts$/m);
  assert.match(diff, /^\+\+\+ b\/src\/example\.ts$/m);
  assert.match(diff, /^@@ -2,9 \+2,9 @@$/m);
  assert.match(diff, /^-line 6$/m);
  assert.match(diff, /^\+line six changed$/m);
  assert.match(diff, /^ line 2$/m);
  assert.match(diff, /^ line 10$/m);
  assert.doesNotMatch(diff, /^ line 1$/m);
  assert.doesNotMatch(diff, /^ line 11$/m);
});

test("contentDiff handles new and identical files", () => {
  assert.equal(
    contentDiff("src/new.ts", "", "export const a = 1;\n"),
    [
      "diff --git a/src/new.ts b/src/new.ts",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,1 @@",
      "+export const a = 1;",
      "",
    ].join("\n"),
  );
  assert.equal(contentDiff("src/same.ts", "unchanged\n", "unchanged\n"), "");
});

test("patch activity renders a diff for a newly written untracked file", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-patch-test-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: folder });
    await mkdir(join(folder, "src"));
    await writeFile(join(folder, "src", "keys.ts"), "export const key = 1;\n");

    const activity = await createPatchActivity({
      folder,
      explanation: "Add the canonical key encoder.",
      changes: [{ path: join(folder, "src", "keys.ts"), kind: "write" }],
    });

    assert.equal(activity.type, "patch");
    if (activity.type !== "patch") return;
    assert.match(activity.diff, /^diff --git/m);
    assert.match(activity.diff, /^\+export const key = 1;/m);
    assert.doesNotMatch(activity.diff, /Diff unavailable|"file_path"/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("patch activity includes four context lines around an edit", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-patch-context-test-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: folder });
    const file = join(folder, "example.ts");
    const original = Array.from(
      { length: 12 },
      (_, index) => `line ${index + 1}`,
    );
    await writeFile(file, `${original.join("\n")}\n`);
    await execFileAsync("git", ["add", "example.ts"], { cwd: folder });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=HyOS Test",
        "-c",
        "user.email=hyos@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      ],
      { cwd: folder },
    );
    original[5] = "line six changed";
    await writeFile(file, `${original.join("\n")}\n`);

    const activity = await createPatchActivity({
      folder,
      explanation: "Change line six.",
      changes: [{ path: file, kind: "update" }],
    });

    assert.equal(activity.type, "patch");
    if (activity.type !== "patch") return;
    assert.match(activity.diff, /^ line 2$/m);
    assert.match(activity.diff, /^ line 10$/m);
    assert.doesNotMatch(activity.diff, /^ line 1$/m);
    assert.doesNotMatch(activity.diff, /^ line 11$/m);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
