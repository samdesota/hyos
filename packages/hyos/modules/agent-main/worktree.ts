import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Central root for all per-repo HyOS git worktrees. */
export function worktreeRoot(): string {
  return path.join(os.homedir(), ".hyos", "worktrees");
}

function run(cwd: string, ...args: string[]): Promise<string> {
  return execFileAsync("git", args, { cwd }).then(({ stdout }) =>
    stdout.trim(),
  );
}

/**
 * Resolve the working folder for a worktree session: create (or reuse) a git
 * worktree for the repo that owns `folder` under
 * `~/.hyos/worktrees/<repo-slug>` and return its path. The worktree gets a
 * branch named after the slug; an existing worktree at that path is reused
 * as-is. Throws when `folder` is not inside a git repository or when the
 * target path exists but is not a git worktree. `root` overrides the central
 * worktree root (tests).
 */
export async function resolveWorktree(
  folder: string,
  root: string = worktreeRoot(),
): Promise<string> {
  let origin: string;
  try {
    origin = await run(folder, "rev-parse", "--show-toplevel");
  } catch {
    throw new Error(`Not a git repository: ${folder}`);
  }
  if (!origin) throw new Error(`Not a git repository: ${folder}`);
  const slug = path.basename(origin);
  const worktreePath = path.join(root, slug);

  try {
    await fs.mkdir(root, { recursive: true });
    await fs.access(worktreePath);
  } catch {
    const branch = `hyos/${slug}`;
    try {
      // New branch named after the slug, seeded from the current HEAD.
      await run(origin, "worktree", "add", "-b", branch, worktreePath);
    } catch {
      // Branch already exists (left over from a removed worktree): reuse it.
      await run(origin, "worktree", "add", worktreePath, branch);
    }
    return worktreePath;
  }

  // Path exists: reuse it when it is a usable git worktree, fail otherwise.
  try {
    await run(worktreePath, "rev-parse", "--is-inside-work-tree");
  } catch {
    throw new Error(
      `Worktree path exists but is not a git worktree: ${worktreePath}`,
    );
  }
  return worktreePath;
}
