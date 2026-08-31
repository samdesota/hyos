import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  GeneratedIgnore,
  LiterateDiff,
  LiterateBlock,
  WorkspaceRepository,
} from "./domain.js";

const MAX_OUTPUT = 60_000;
const MAX_FILES_PER_WARNING_FOLDER = 10;

export type RepositorySpec = WorkspaceRepository;
export type WorkspaceMode = "checkout" | "worktree";

export interface WorktreeWarning {
  repository: string;
  path: string;
  message: string;
}

export interface CommitResult {
  repository: string;
  hash: string;
  message: string;
}

type PatchBlock = Extract<LiterateBlock, { kind: "apply_patch" }>;
type PatchRef = Pick<PatchBlock, "id" | "repository" | "patch">;
type Snapshot = Map<string, string>;

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  input?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveProcess({
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        exitCode: code ?? 1,
      });
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

function assertRelativeProjectPath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error("Paths must stay inside the repository root");
  }
}

function assertCommand(command: string, args: readonly string[]): void {
  if (!["rg", "git", "npm"].includes(command)) {
    throw new Error(`Command is not available to the agent: ${command}`);
  }
  if (
    command === "git" &&
    !["status", "diff", "show", "log", "ls-files", "grep"].includes(
      args[0] ?? "",
    )
  ) {
    throw new Error("Only read-only git commands are available to the agent");
  }
}

function patchFilePaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^\+\+\+ b\/(.+)$/) ?? line.match(/^--- a\/(.+)$/);
    if (match?.[1] && match[1] !== "/dev/null") paths.add(match[1]);
  }
  return [...paths];
}

function patchBlocks(document: LiterateDiff | null): PatchRef[] {
  return (document?.blocks ?? [])
    .filter((block): block is PatchBlock => block.kind === "apply_patch")
    .map(({ id, repository, patch }) => ({ id, repository, patch }));
}

function samePatch(left: PatchRef, right: PatchRef): boolean {
  return (
    left.id === right.id &&
    left.repository === right.repository &&
    left.patch === right.patch
  );
}

function ignored(path: string, entries: readonly GeneratedIgnore[]): boolean {
  return entries.some(
    (entry) =>
      entry.path === path ||
      (entry.path.endsWith("/**") &&
        path.startsWith(entry.path.slice(0, -3) + "/")),
  );
}

function consistencyWarnings(
  repository: string,
  changedPaths: readonly string[],
): WorktreeWarning[] {
  const rootFiles: string[] = [];
  const folders = new Map<string, string[]>();
  for (const path of [...changedPaths].sort()) {
    const separator = path.indexOf("/");
    if (separator === -1) {
      rootFiles.push(path);
      continue;
    }
    const folder = path.slice(0, separator);
    const paths = folders.get(folder) ?? [];
    paths.push(path);
    folders.set(folder, paths);
  }

  const warnings = rootFiles.map((path) => ({
    repository,
    path,
    message: `${repository}:${path} changed outside the literate diff`,
  }));
  for (const [folder, paths] of [...folders].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (paths.length > MAX_FILES_PER_WARNING_FOLDER) {
      const path = `${folder}/**`;
      warnings.push({
        repository,
        path,
        message: `${repository}:${path} contains ${paths.length} changes outside the literate diff; inspect it with run_command or add it as a generated-file ignore`,
      });
      continue;
    }
    warnings.push(
      ...paths.map((path) => ({
        repository,
        path,
        message: `${repository}:${path} changed outside the literate diff`,
      })),
    );
  }
  return warnings;
}

async function changedPaths(root: string): Promise<string[]> {
  const [staged, unstaged, untracked] = await Promise.all([
    runProcess("git", ["diff", "--cached", "--name-only", "-z"], root),
    runProcess("git", ["diff", "--name-only", "-z"], root),
    runProcess(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      root,
    ),
  ]);
  if (staged.exitCode !== 0 || unstaged.exitCode !== 0) {
    throw new Error(
      `Could not inspect repository changes: ${staged.stderr || unstaged.stderr}`,
    );
  }
  if (untracked.exitCode !== 0) {
    throw new Error(`Could not inspect untracked files: ${untracked.stderr}`);
  }
  return [staged.stdout, unstaged.stdout, untracked.stdout]
    .flatMap((value) => value.split("\0"))
    .filter(Boolean)
    .filter((path, index, all) => all.indexOf(path) === index);
}

async function fileFingerprint(root: string, path: string): Promise<string> {
  const target = resolve(root, path);
  try {
    const details = await lstat(target);
    if (details.isDirectory()) return "directory";
    const contents = await readFile(target);
    return createHash("sha256").update(contents).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "deleted";
    throw error;
  }
}

async function takeSnapshot(root: string): Promise<Snapshot> {
  const paths = await changedPaths(root);
  return new Map(
    await Promise.all(
      paths.map(
        async (path) => [path, await fileFingerprint(root, path)] as const,
      ),
    ),
  );
}

async function applyPatch(
  root: string,
  patch: string,
  options: { reverse?: boolean; allowAlreadyApplied?: boolean } = {},
): Promise<"applied" | "already_applied"> {
  const reverse = options.reverse ? ["--reverse"] : [];
  const check = await runProcess(
    "git",
    ["apply", ...reverse, "--check", "-"],
    root,
    patch,
  );
  if (check.exitCode !== 0) {
    if (!options.reverse && options.allowAlreadyApplied) {
      const already = await runProcess(
        "git",
        ["apply", "--reverse", "--check", "-"],
        root,
        patch,
      );
      if (already.exitCode === 0) return "already_applied";
    }
    throw new Error(check.stderr || "Patch does not apply cleanly");
  }
  const result = await runProcess(
    "git",
    ["apply", ...reverse, "--whitespace=nowarn", "-"],
    root,
    patch,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "Could not apply patch");
  }
  return "applied";
}

export interface ProjectTools {
  repositoryNames(): readonly string[];
  repositorySpecs(): readonly RepositorySpec[];
  configureRepositories(specs: readonly RepositorySpec[]): Promise<void>;
  prepareRepositories(
    specs: readonly RepositorySpec[],
    mode: WorkspaceMode,
  ): Promise<readonly RepositorySpec[]>;
  initialize(): Promise<void>;
  readFile(repository: string, path: string): Promise<string>;
  runCommand(
    repository: string,
    command: string,
    args: readonly string[],
  ): Promise<string>;
  syncPatches(previous: LiterateDiff | null, next: LiterateDiff): Promise<void>;
  checkConsistency(
    ignores: readonly GeneratedIgnore[],
  ): Promise<WorktreeWarning[]>;
  commit(
    document: LiterateDiff,
    messages: Readonly<Record<string, string>>,
  ): Promise<CommitResult[]>;
  enrichDocument(document: LiterateDiff): Promise<LiterateDiff>;
}

export function createProjectTools(
  input: string | readonly RepositorySpec[] = [],
  options: { worktreeRoot?: string } = {},
): ProjectTools {
  const specs =
    typeof input === "string"
      ? [{ name: "workspace", root: input }]
      : [...input];
  if (new Set(specs.map((spec) => spec.name)).size !== specs.length) {
    throw new Error("Repository names must be unique");
  }
  const repositories = new Map(
    specs.map((spec) => [spec.name, resolve(spec.root)] as const),
  );
  const expected = new Map<string, Snapshot>();

  async function normalizedSpecs(
    next: readonly RepositorySpec[],
  ): Promise<RepositorySpec[]> {
    if (next.length === 0)
      throw new Error("Select at least one repository folder");
    const normalized = await Promise.all(
      next.map(async (spec) => {
        const selected = await realpath(resolve(spec.root));
        const result = await runProcess(
          "git",
          ["rev-parse", "--show-toplevel"],
          selected,
        );
        if (result.exitCode !== 0) {
          throw new Error(`${selected} is not inside a Git repository`);
        }
        return { name: spec.name.trim(), root: result.stdout.trim() };
      }),
    );
    if (normalized.some((spec) => spec.name.length === 0)) {
      throw new Error("Repository names cannot be empty");
    }
    if (
      new Set(normalized.map((spec) => spec.name)).size !== normalized.length
    ) {
      throw new Error("Repository names must be unique");
    }
    if (
      new Set(normalized.map((spec) => spec.root)).size !== normalized.length
    ) {
      throw new Error("The same repository cannot be selected twice");
    }
    return normalized;
  }

  function rootFor(repository: string): string {
    const root = repositories.get(repository);
    if (!root) throw new Error(`Unknown repository: ${repository}`);
    return root;
  }

  async function initialize() {
    if (expected.size > 0) return;
    if (repositories.size === 0)
      throw new Error("Select a repository folder before starting the agent");
    const normalized = await normalizedSpecs(
      [...repositories].map(([name, root]) => ({ name, root })),
    );
    repositories.clear();
    for (const spec of normalized) repositories.set(spec.name, spec.root);
    for (const [name, root] of repositories) {
      expected.set(name, await takeSnapshot(root));
    }
  }

  async function configureRepositories(next: readonly RepositorySpec[]) {
    const normalized = await normalizedSpecs(next);
    repositories.clear();
    expected.clear();
    for (const spec of normalized) repositories.set(spec.name, spec.root);
    await initialize();
  }

  async function copyWorktreeIncludes(source: string, target: string) {
    let contents: string;
    try {
      contents = await readFile(join(source, ".worktreeinclude"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))) {
      assertRelativeProjectPath(entry);
      try {
        await mkdir(dirname(join(target, entry)), { recursive: true });
        await cp(join(source, entry), join(target, entry), { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async function prepareRepositories(
    next: readonly RepositorySpec[],
    mode: WorkspaceMode,
  ): Promise<readonly RepositorySpec[]> {
    const normalized = await normalizedSpecs(next);
    if (mode === "checkout") {
      await configureRepositories(normalized);
      return repositorySpecs();
    }
    const worktreeRoot = resolve(
      options.worktreeRoot ?? ".data/hyagent-worktrees",
    );
    await mkdir(worktreeRoot, { recursive: true });
    const created: RepositorySpec[] = [];
    const worktrees: Array<{ source: string; target: string; branch: string }> =
      [];
    try {
      for (const spec of normalized) {
        const token = randomUUID().slice(0, 8);
        const safeName = spec.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
        const target = join(worktreeRoot, `${safeName}-${token}`);
        const branch = `hyagent/${safeName}-${token}`;
        const result = await runProcess(
          "git",
          ["worktree", "add", "-b", branch, target, "HEAD"],
          spec.root,
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `Could not create a worktree for ${spec.name}: ${result.stderr || result.stdout}`,
          );
        }
        worktrees.push({ source: spec.root, target, branch });
        await copyWorktreeIncludes(spec.root, target);
        created.push({ name: spec.name, root: target });
      }
      await configureRepositories(created);
      return repositorySpecs();
    } catch (error) {
      for (const worktree of worktrees.reverse()) {
        await runProcess(
          "git",
          ["worktree", "remove", "--force", worktree.target],
          worktree.source,
        );
        await runProcess(
          "git",
          ["branch", "-D", worktree.branch],
          worktree.source,
        );
      }
      throw error;
    }
  }

  function repositorySpecs(): RepositorySpec[] {
    return [...repositories].map(([name, root]) => ({ name, root }));
  }

  async function transition(
    repository: string,
    previous: readonly PatchRef[],
    next: readonly PatchRef[],
  ) {
    const root = rootFor(repository);
    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < next.length &&
      samePatch(previous[prefix]!, next[prefix]!)
    ) {
      prefix += 1;
    }
    if (prefix === previous.length && prefix === next.length) return;

    const removed = previous.slice(prefix);
    const added = next.slice(prefix);
    const applied: PatchRef[] = [];
    let failed: PatchRef | undefined;
    try {
      for (const patch of [...removed].reverse()) {
        await applyPatch(root, patch.patch, { reverse: true });
      }
      for (const patch of added) {
        failed = patch;
        const result = await applyPatch(root, patch.patch, {
          allowAlreadyApplied: removed.length === 0,
        });
        if (result === "applied") applied.push(patch);
      }
      failed = undefined;
    } catch (error) {
      for (const patch of [...applied].reverse()) {
        await applyPatch(root, patch.patch, { reverse: true });
      }
      for (const patch of removed) await applyPatch(root, patch.patch);
      throw new Error(
        `Replay stopped in ${repository}${failed ? ` at ${failed.id}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    repositoryNames: () => [...repositories.keys()],
    repositorySpecs,
    configureRepositories,
    prepareRepositories,
    initialize,
    async readFile(repository, path) {
      assertRelativeProjectPath(path);
      const root = rootFor(repository);
      const target = await realpath(resolve(root, path));
      const location = relative(root, target);
      if (location.startsWith("..") || isAbsolute(location)) {
        throw new Error("Resolved file is outside the repository root");
      }
      const contents = await readFile(target, "utf8");
      if (contents.length > 200_000)
        throw new Error("File is too large to read");
      return contents;
    },
    async runCommand(repository, command, args) {
      assertCommand(command, args);
      return JSON.stringify(
        await runProcess(command, args, rootFor(repository)),
      );
    },
    async syncPatches(previous, next) {
      await initialize();
      const oldPatches = patchBlocks(previous);
      const newPatches = patchBlocks(next);
      for (const patch of newPatches) rootFor(patch.repository);

      const changedRepositories = [...repositories.keys()].filter(
        (repository) => {
          const before = oldPatches.filter(
            (patch) => patch.repository === repository,
          );
          const after = newPatches.filter(
            (patch) => patch.repository === repository,
          );
          return (
            before.length !== after.length ||
            before.some((patch, index) => !samePatch(patch, after[index]!))
          );
        },
      );
      const completed: string[] = [];
      try {
        for (const repository of changedRepositories) {
          await transition(
            repository,
            oldPatches.filter((patch) => patch.repository === repository),
            newPatches.filter((patch) => patch.repository === repository),
          );
          completed.push(repository);
        }
      } catch (error) {
        for (const repository of completed.reverse()) {
          await transition(
            repository,
            newPatches.filter((patch) => patch.repository === repository),
            oldPatches.filter((patch) => patch.repository === repository),
          );
        }
        throw error;
      }

      for (const repository of changedRepositories) {
        const current = await takeSnapshot(rootFor(repository));
        const touched = [...oldPatches, ...newPatches]
          .filter((patch) => patch.repository === repository)
          .flatMap((patch) => patchFilePaths(patch.patch));
        const baseline = expected.get(repository)!;
        for (const path of touched) {
          const fingerprint = current.get(path);
          if (fingerprint === undefined) baseline.delete(path);
          else baseline.set(path, fingerprint);
        }
      }
    },
    async checkConsistency(ignores) {
      await initialize();
      const warnings: WorktreeWarning[] = [];
      for (const [repository, root] of repositories) {
        const baseline = expected.get(repository)!;
        const current = await takeSnapshot(root);
        const entries = ignores.filter(
          (entry) => entry.repository === repository,
        );
        const paths = new Set([...baseline.keys(), ...current.keys()]);
        warnings.push(
          ...consistencyWarnings(
            repository,
            [...paths].filter(
              (path) =>
                baseline.get(path) !== current.get(path) &&
                !ignored(path, entries),
            ),
          ),
        );
      }
      return warnings;
    },
    async commit(document, messages) {
      await initialize();
      const patches = patchBlocks(document);
      const affected = [...new Set(patches.map((patch) => patch.repository))];
      if (affected.length === 0) {
        throw new Error("The literate diff contains no code changes to commit");
      }
      const results: CommitResult[] = [];
      for (const repository of affected) {
        const root = rootFor(repository);
        const paths = [
          ...new Set(
            patches
              .filter((patch) => patch.repository === repository)
              .flatMap((patch) => patchFilePaths(patch.patch)),
          ),
        ];
        const message = messages[repository]?.trim();
        if (!message) {
          throw new Error(`No commit message was generated for ${repository}`);
        }
        if (paths.length === 0) {
          throw new Error(`No changed paths were found for ${repository}`);
        }
        const staged = await runProcess(
          "git",
          ["add", "-A", "--", ...paths],
          root,
        );
        if (staged.exitCode !== 0) {
          throw new Error(
            `Could not stage ${repository}: ${staged.stderr || staged.stdout}`,
          );
        }
        const committed = await runProcess(
          "git",
          ["commit", "--only", "-m", message, "--", ...paths],
          root,
        );
        if (committed.exitCode !== 0) {
          throw new Error(
            `Could not commit ${repository}: ${committed.stderr || committed.stdout}`,
          );
        }
        const head = await runProcess("git", ["rev-parse", "HEAD"], root);
        if (head.exitCode !== 0) {
          throw new Error(`Could not read the new commit for ${repository}`);
        }
        expected.set(repository, await takeSnapshot(root));
        results.push({
          repository,
          hash: head.stdout.trim(),
          message,
        });
      }
      return results;
    },
    async enrichDocument(document) {
      const blocks = await Promise.all(
        document.blocks.map(async (block) => {
          if (block.kind !== "apply_patch") return block;
          const file = block.file ?? patchFilePaths(block.patch)[0];
          if (!file) return block;
          try {
            return {
              ...block,
              file,
              fullFile: await this.readFile(block.repository, file),
            };
          } catch {
            return { ...block, file };
          }
        }),
      );
      return { ...document, blocks };
    },
  };
}
