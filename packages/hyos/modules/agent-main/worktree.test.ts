import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { resolveWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

test("resolveWorktree creates, reuses, and validates git worktrees", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "hyos-worktree-"));
  const root = path.join(scratch, "worktrees");
  const origin = path.join(scratch, "origin");
  try {
    await execFileAsync("git", ["init", "--quiet", origin]);
    await writeFile(path.join(origin, "file.txt"), "hi\n");
    await git(origin, "add", "file.txt");
    await git(
      origin,
      "-c",
      "user.email=test@hyos.dev",
      "-c",
      "user.name=Test",
      "commit",
      "--quiet",
      "-m",
      "init",
    );

    // First call creates <root>/origin on a hyos/<slug> branch.
    const worktreePath = await resolveWorktree(origin, root);
    assert.equal(worktreePath, path.join(root, "origin"));
    assert.equal(
      await git(worktreePath, "branch", "--show-current"),
      "hyos/origin",
    );

    // Second call reuses the same worktree (still on the same branch).
    const reused = await resolveWorktree(origin, root);
    assert.equal(reused, worktreePath);
    assert.equal(await git(reused, "branch", "--show-current"), "hyos/origin");

    // A path in the root that is not a git worktree is rejected, never
    // clobbered: pre-create <root>/plain as a plain directory, then resolve
    // a repo whose slug would collide with it.
    const plain = path.join(root, "plain");
    await execFileAsync("mkdir", ["-p", plain]);
    const plainOrigin = path.join(scratch, "plain");
    await execFileAsync("git", ["init", "--quiet", plainOrigin]);
    await writeFile(path.join(plainOrigin, "file.txt"), "hi\n");
    await git(plainOrigin, "add", "file.txt");
    await git(
      plainOrigin,
      "-c",
      "user.email=test@hyos.dev",
      "-c",
      "user.name=Test",
      "commit",
      "--quiet",
      "-m",
      "init",
    );
    await assert.rejects(
      () => resolveWorktree(plainOrigin, root),
      /not a git worktree/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("resolveWorktree throws for folders outside a git repository", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "hyos-worktree-"));
  try {
    await assert.rejects(
      () => resolveWorktree(scratch, path.join(scratch, "wt")),
      /Not a git repository/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
