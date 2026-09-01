import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

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

export interface WorkspacePreparation {
  mode: WorkspaceMode;
  baseOnLatestRemoteMain?: boolean;
}

export interface WorktreeWarning {
  repository: string;
  path: string;
  message: string;
}

export interface WorktreeState {
  dirtyRepositories: string[];
  unaccountedChanges: WorktreeWarning[];
}

export interface CommitResult {
  repository: string;
  hash: string;
  message: string;
}

export interface YeetResult {
  repository: string;
  stdout: string;
  stderr: string;
}

export interface PatchCursorResult {
  appliedThrough: string | null;
  failed?: {
    stepId: string;
    direction: "rewind" | "replay";
    error: string;
  };
}

type PatchBlock = Extract<LiterateBlock, { kind: "apply_patch" }>;
type PatchRef = Pick<PatchBlock, "id" | "repository" | "patch">;
type Snapshot = Map<string, string>;

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  input?: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Operation aborted"));
  }
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
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

function patchFilePaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^\+\+\+ b\/(.+)$/) ?? line.match(/^--- a\/(.+)$/);
    if (match?.[1] && match[1] !== "/dev/null") paths.add(match[1]);
  }
  return [...paths];
}

interface ContextlessHunk {
  path: string;
  header: string;
}

function contextlessModificationHunk(
  patch: string,
): ContextlessHunk | undefined {
  for (const section of patch.split(/(?=^diff --git )/m)) {
    if (!section.startsWith("diff --git ")) continue;
    if (
      /^--- \/dev\/null$/m.test(section) ||
      /^\+\+\+ \/dev\/null$/m.test(section)
    ) {
      continue;
    }
    const path = section.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? "unknown file";
    const lines = section.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const header = lines[index]!;
      if (!header.startsWith("@@ ")) continue;
      let hasContext = false;
      for (let body = index + 1; body < lines.length; body += 1) {
        const line = lines[body]!;
        if (line.startsWith("@@ ") || line.startsWith("diff --git ")) break;
        if (line.startsWith(" ")) {
          hasContext = true;
          break;
        }
      }
      if (!hasContext) return { path, header };
    }
  }
  return undefined;
}

function patchFailureMessage(patch: string, stderr: string): string {
  const contextless = contextlessModificationHunk(patch);
  if (contextless) {
    return `Patch was rejected before the literate diff was updated: ${contextless.path} has a modification hunk with no unchanged surrounding context (${contextless.header}). Include at least one unchanged line, prefixed with a space, before or after the edit.`;
  }
  const detail = stderr.trim();
  if (/patch (failed|does not apply)/i.test(detail)) {
    return `Patch was rejected before the literate diff was updated because its context does not match the current file. Read the file again and regenerate the hunk with unchanged surrounding lines. Git reported: ${detail}`;
  }
  if (/corrupt patch|unrecognized input/i.test(detail)) {
    return `Patch was rejected before the literate diff was updated because it is not a valid unified diff. Git reported: ${detail}`;
  }
  return `Patch was rejected before the literate diff was updated. Git reported: ${detail || "the patch does not apply cleanly"}`;
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

function assertGeneratedIgnoresDoNotHidePatches(document: LiterateDiff): void {
  for (const patch of patchBlocks(document)) {
    for (const path of patchFilePaths(patch.patch)) {
      const entry = document.generatedIgnores.find(
        (candidate) =>
          candidate.repository === patch.repository &&
          ignored(path, [candidate]),
      );
      if (entry) {
        throw new Error(
          `Generated ignore ${entry.repository}:${entry.path} overlaps patch-controlled file ${patch.repository}:${path} in block ${patch.id}. Generated ignores may only cover files that are not represented by the literate diff.`,
        );
      }
    }
  }
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
  options: { reverse?: boolean } = {},
): Promise<void> {
  const reverse = options.reverse ? ["--reverse"] : [];
  const check = await runProcess(
    "git",
    ["apply", ...reverse, "--check", "-"],
    root,
    patch,
  );
  if (check.exitCode !== 0) {
    throw new Error(patchFailureMessage(patch, check.stderr));
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
}

export interface ProjectTools {
  repositoryNames(): readonly string[];
  repositorySpecs(): readonly RepositorySpec[];
  configureRepositories(specs: readonly RepositorySpec[]): Promise<void>;
  canBaseOnLatestRemoteMain(specs: readonly RepositorySpec[]): Promise<boolean>;
  prepareRepositories(
    specs: readonly RepositorySpec[],
    preparation: WorkspacePreparation,
  ): Promise<readonly RepositorySpec[]>;
  prepareBaseline(
    sessionId: string,
    source: "worktree" | "head",
  ): Promise<void>;
  initialize(): Promise<void>;
  readFile(repository: string, path: string): Promise<string>;
  runCommand(
    repository: string,
    command: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string>;
  validateDocumentEdit(
    previous: LiterateDiff | null,
    next: LiterateDiff,
    appliedThrough: string | null,
  ): Promise<void>;
  movePatchCursor(
    document: LiterateDiff,
    appliedThrough: string | null,
    target: string | null,
  ): Promise<PatchCursorResult>;
  checkConsistency(
    ignores: readonly GeneratedIgnore[],
  ): Promise<WorktreeWarning[]>;
  commit(
    document: LiterateDiff,
    messages: Readonly<Record<string, string>>,
  ): Promise<CommitResult[]>;
  inspectChanges(document: LiterateDiff | null): Promise<WorktreeState>;
  yeetRepositories(specs?: readonly RepositorySpec[]): Promise<string[]>;
  yeet(): Promise<YeetResult[]>;
  enrichDocument(document: LiterateDiff): Promise<LiterateDiff>;
}

export function createProjectTools(
  input: string | readonly RepositorySpec[] = [],
  options: { worktreeRoot?: string; historyRoot?: string } = {},
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
  const historyRoot = resolve(options.historyRoot ?? ".data/hyagent-baselines");
  let activeBaseline: string | undefined;

  function safeSegment(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  function repositoryBaseline(root: string, repository: string): string {
    return join(root, safeSegment(repository));
  }

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
    activeBaseline = undefined;
    for (const spec of normalized) repositories.set(spec.name, spec.root);
    await initialize();
  }

  async function copyVisibleWorktree(root: string, target: string) {
    const listed = await runProcess(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      root,
    );
    if (listed.exitCode !== 0) {
      throw new Error(`Could not capture worktree baseline: ${listed.stderr}`);
    }
    for (const path of listed.stdout.split("\0").filter(Boolean)) {
      assertRelativeProjectPath(path);
      const source = join(root, path);
      try {
        const details = await lstat(source);
        if (details.isDirectory()) continue;
        await mkdir(dirname(join(target, path)), { recursive: true });
        await cp(source, join(target, path), { preserveTimestamps: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async function copyHeadTree(root: string, target: string, scratch: string) {
    const head = await runProcess(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      root,
    );
    if (head.exitCode !== 0) return;
    const archive = join(scratch, `${safeSegment(root)}.tar`);
    const archived = await runProcess(
      "git",
      ["archive", "--format=tar", `--output=${archive}`, "HEAD"],
      root,
    );
    if (archived.exitCode !== 0) {
      throw new Error(`Could not capture HEAD baseline: ${archived.stderr}`);
    }
    const extracted = await runProcess(
      "tar",
      ["-xf", archive, "-C", target],
      root,
    );
    await rm(archive, { force: true });
    if (extracted.exitCode !== 0) {
      throw new Error(`Could not extract HEAD baseline: ${extracted.stderr}`);
    }
  }

  async function prepareBaseline(
    sessionId: string,
    source: "worktree" | "head",
  ) {
    await initialize();
    const baseline = join(historyRoot, safeSegment(sessionId));
    const ready = join(baseline, "ready.json");
    try {
      await readFile(ready, "utf8");
      activeBaseline = baseline;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(baseline, { recursive: true, force: true });
    await mkdir(baseline, { recursive: true });
    try {
      for (const [repository, root] of repositories) {
        const target = repositoryBaseline(baseline, repository);
        await mkdir(target, { recursive: true });
        if (source === "head") await copyHeadTree(root, target, baseline);
        else await copyVisibleWorktree(root, target);
      }
      await writeFile(
        ready,
        JSON.stringify({
          sessionId,
          source,
          repositories: [...repositories.keys()],
        }),
        "utf8",
      );
      activeBaseline = baseline;
    } catch (error) {
      await rm(baseline, { recursive: true, force: true });
      throw error;
    }
  }

  async function restoreControlledPaths(patches: readonly PatchRef[]) {
    if (!activeBaseline) {
      throw new Error("The session baseline has not been prepared");
    }
    const repositoryPaths = new Map<string, Set<string>>();
    for (const patch of patches) {
      const paths = repositoryPaths.get(patch.repository) ?? new Set<string>();
      for (const path of patchFilePaths(patch.patch)) paths.add(path);
      repositoryPaths.set(patch.repository, paths);
    }
    for (const [repository, paths] of repositoryPaths) {
      const root = rootFor(repository);
      const baseline = repositoryBaseline(activeBaseline, repository);
      for (const path of paths) {
        assertRelativeProjectPath(path);
        const target = join(root, path);
        await rm(target, { recursive: true, force: true });
        try {
          await lstat(join(baseline, path));
          await mkdir(dirname(target), { recursive: true });
          await cp(join(baseline, path), target, { preserveTimestamps: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
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

  async function hasOriginRemote(spec: RepositorySpec): Promise<boolean> {
    const result = await runProcess(
      "git",
      ["remote", "get-url", "origin"],
      spec.root,
    );
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }

  async function canBaseOnLatestRemoteMain(
    next: readonly RepositorySpec[],
  ): Promise<boolean> {
    const normalized = await normalizedSpecs(next);
    return allHaveOriginRemote(normalized);
  }

  async function allHaveOriginRemote(
    normalized: readonly RepositorySpec[],
  ): Promise<boolean> {
    const remoteChecks = await Promise.all(normalized.map(hasOriginRemote));
    return remoteChecks.every(Boolean);
  }

  async function prepareRepositories(
    next: readonly RepositorySpec[],
    preparation: WorkspacePreparation,
  ): Promise<readonly RepositorySpec[]> {
    const normalized = await normalizedSpecs(next);
    if (preparation.mode === "checkout") {
      await configureRepositories(normalized);
      return repositorySpecs();
    }
    const worktreeRoot = resolve(
      options.worktreeRoot ?? ".data/hyagent-worktrees",
    );
    const baseOnLatestRemoteMain =
      preparation.baseOnLatestRemoteMain &&
      (await allHaveOriginRemote(normalized));
    await mkdir(worktreeRoot, { recursive: true });
    const created: RepositorySpec[] = [];
    const worktrees: Array<{ source: string; target: string; branch: string }> =
      [];
    try {
      for (const spec of normalized) {
        const startRef = baseOnLatestRemoteMain ? "origin/main" : "HEAD";
        if (baseOnLatestRemoteMain) {
          const fetch = await runProcess(
            "git",
            [
              "fetch",
              "--no-tags",
              "origin",
              "+refs/heads/main:refs/remotes/origin/main",
            ],
            spec.root,
          );
          if (fetch.exitCode !== 0) {
            throw new Error(
              `Could not fetch origin/main for ${spec.name}: ${fetch.stderr || fetch.stdout}`,
            );
          }
        }
        const token = randomUUID().slice(0, 8);
        const safeName = spec.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
        const target = join(worktreeRoot, `${safeName}-${token}`);
        const branch = `hyagent/${safeName}-${token}`;
        const result = await runProcess(
          "git",
          ["worktree", "add", "-b", branch, target, startRef],
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

  function patchIndex(
    patches: readonly PatchRef[],
    stepId: string | null,
    label: string,
  ): number {
    if (stepId === null) return -1;
    const index = patches.findIndex((patch) => patch.id === stepId);
    if (index < 0) {
      throw new Error(`${label} patch step does not exist: ${stepId}`);
    }
    return index;
  }

  async function recordPatchState(patches: readonly PatchRef[]) {
    const repositoryPaths = new Map<string, Set<string>>();
    for (const patch of patches) {
      const paths = repositoryPaths.get(patch.repository) ?? new Set<string>();
      for (const path of patchFilePaths(patch.patch)) paths.add(path);
      repositoryPaths.set(patch.repository, paths);
    }
    for (const [repository, paths] of repositoryPaths) {
      const root = rootFor(repository);
      const baseline = expected.get(repository)!;
      const changed = await takeSnapshot(root);
      for (const path of paths) {
        const fingerprint = changed.get(path);
        if (fingerprint === undefined) baseline.delete(path);
        else baseline.set(path, fingerprint);
      }
    }
  }

  async function expectedPatchState(
    document: LiterateDiff,
  ): Promise<Map<string, Map<string, string>>> {
    if (!activeBaseline) {
      throw new Error("The session baseline has not been prepared");
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), "hyagent-inspect-"));
    const result = new Map<string, Map<string, string>>();
    try {
      for (const repository of repositories.keys()) {
        const patches = patchBlocks(document).filter(
          (patch) => patch.repository === repository,
        );
        if (patches.length === 0) continue;
        const root = join(temporaryRoot, safeSegment(repository));
        const baseline = repositoryBaseline(activeBaseline, repository);
        const paths = [
          ...new Set(patches.flatMap((patch) => patchFilePaths(patch.patch))),
        ];
        await mkdir(root, { recursive: true });
        for (const path of paths) {
          const target = join(root, path);
          try {
            await lstat(join(baseline, path));
            await mkdir(dirname(target), { recursive: true });
            await cp(join(baseline, path), target, {
              preserveTimestamps: true,
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        for (const patch of patches) await applyPatch(root, patch.patch);
        result.set(
          repository,
          new Map(
            await Promise.all(
              paths.map(
                async (path) =>
                  [path, await fileFingerprint(root, path)] as const,
              ),
            ),
          ),
        );
      }
      return result;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  return {
    repositoryNames: () => [...repositories.keys()],
    repositorySpecs,
    configureRepositories,
    canBaseOnLatestRemoteMain,
    prepareRepositories,
    prepareBaseline,
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
    async runCommand(repository, command, args, signal) {
      return JSON.stringify(
        await runProcess(command, args, rootFor(repository), undefined, signal),
      );
    },
    async validateDocumentEdit(previous, next, appliedThrough) {
      await initialize();
      assertGeneratedIgnoresDoNotHidePatches(next);
      const oldPatches = patchBlocks(previous);
      const newPatches = patchBlocks(next);
      const appliedIndex = patchIndex(
        oldPatches,
        appliedThrough,
        "Currently applied",
      );
      for (let index = 0; index <= appliedIndex; index += 1) {
        const before = oldPatches[index]!;
        const after = newPatches[index];
        if (!after || !samePatch(before, after)) {
          const previousStep = oldPatches[index - 1]?.id ?? null;
          throw new Error(
            `Patch step ${before.id} is currently applied. Rewind to ${previousStep ?? "the beginning"} before editing, removing, or reordering it.`,
          );
        }
      }
      for (const patch of newPatches) rootFor(patch.repository);
    },
    async movePatchCursor(document, appliedThrough, target) {
      await initialize();
      const patches = patchBlocks(document);
      const currentIndex = patchIndex(
        patches,
        appliedThrough,
        "Currently applied",
      );
      const targetIndex = patchIndex(patches, target, "Target");
      const direction = targetIndex < currentIndex ? "rewind" : "replay";
      await restoreControlledPaths(patches);
      for (let index = 0; index <= targetIndex; index += 1) {
        const patch = patches[index]!;
        try {
          await applyPatch(rootFor(patch.repository), patch.patch);
        } catch (error) {
          await recordPatchState(patches);
          return {
            appliedThrough: patches[index - 1]?.id ?? null,
            failed: {
              stepId: patch.id,
              direction,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      await recordPatchState(patches);
      return { appliedThrough: target };
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
      const candidates = [
        ...new Set([
          ...patches.map((patch) => patch.repository),
          ...document.generatedIgnores.map((entry) => entry.repository),
        ]),
      ];
      const pathsByRepository = new Map<string, string[]>();
      for (const repository of candidates) {
        const entries = document.generatedIgnores.filter(
          (entry) => entry.repository === repository,
        );
        const paths = [
          ...new Set([
            ...patches
              .filter((patch) => patch.repository === repository)
              .flatMap((patch) => patchFilePaths(patch.patch)),
            ...(await changedPaths(rootFor(repository))).filter((path) =>
              ignored(path, entries),
            ),
          ]),
        ];
        if (paths.length > 0) pathsByRepository.set(repository, paths);
      }
      const affected = [...pathsByRepository.keys()];
      if (affected.length === 0) {
        throw new Error("The literate diff contains no code changes to commit");
      }
      const results: CommitResult[] = [];
      for (const repository of affected) {
        const root = rootFor(repository);
        const paths = pathsByRepository.get(repository)!;
        const message = messages[repository]?.trim();
        if (!message) {
          throw new Error(`No commit message was generated for ${repository}`);
        }
        if (paths.length === 0) {
          throw new Error(`No changed paths were found for ${repository}`);
        }
        const staged = await runProcess(
          "git",
          ["add", "-f", "-A", "--", ...paths],
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
    async inspectChanges(document) {
      const dirtyRepositories: string[] = [];
      const unaccountedChanges: WorktreeWarning[] = [];
      const controlledState = document
        ? await expectedPatchState(document)
        : new Map<string, Map<string, string>>();
      for (const [repository, root] of repositories) {
        const paths = await changedPaths(root);
        if (paths.length === 0) continue;
        dirtyRepositories.push(repository);
        const controlled = controlledState.get(repository) ?? new Map();
        const entries =
          document?.generatedIgnores.filter(
            (entry) => entry.repository === repository,
          ) ?? [];
        unaccountedChanges.push(
          ...consistencyWarnings(
            repository,
            (
              await Promise.all(
                paths.map(async (path) => ({
                  path,
                  matchesPatch:
                    controlled.has(path) &&
                    controlled.get(path) ===
                      (await fileFingerprint(root, path)),
                })),
              )
            )
              .filter(
                ({ path, matchesPatch }) =>
                  !matchesPatch && !ignored(path, entries),
              )
              .map(({ path }) => path),
          ),
        );
      }
      return { dirtyRepositories, unaccountedChanges };
    },
    async yeetRepositories(specs) {
      const available: string[] = [];
      const candidates = specs
        ? specs.map(({ name, root }) => [name, resolve(root)] as const)
        : [...repositories];
      for (const [repository, root] of candidates) {
        try {
          const script = await lstat(join(root, "yeet.sh"));
          if (script.isFile() || script.isSymbolicLink()) {
            available.push(repository);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return available;
    },
    async yeet() {
      const available = await this.yeetRepositories();
      if (available.length === 0) {
        throw new Error("No selected repository has a root-level yeet.sh");
      }
      const results: YeetResult[] = [];
      for (const repository of available) {
        const result = await runProcess(
          "./yeet.sh",
          [],
          rootFor(repository),
          undefined,
          undefined,
          300_000,
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `yeet.sh failed in ${repository}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
          );
        }
        results.push({
          repository,
          stdout: result.stdout,
          stderr: result.stderr,
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
