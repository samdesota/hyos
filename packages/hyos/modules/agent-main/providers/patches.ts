import { execFile } from "node:child_process";

import type {
  AgentActivity,
  AgentPatchChange,
} from "../../../capabilities/agent.js";

export const patchExplanationInstruction = `Before every file-changing tool call, explain in one concise sentence what the patch does and why. Do not call an edit, write, notebook edit, or apply-patch tool until you have provided that explanation.`;

export const claudePatchToolInstruction = `Make file changes with Edit and Write. They retain their standard Claude Code arguments and additionally require an explanation argument that concisely explains what the change does and why. Do not modify files with Bash.`;

export const claudeCompletionInstruction = `Continue until the entire user request is implemented and verified. When no requested work remains, call Complete with a concise summary and the verification you performed. Do not call Complete for a partial implementation or stop merely because one file was changed.`;

export function promptWithPatchContract(prompt: string): string {
  return `${patchExplanationInstruction}\n\nUser request:\n${prompt}`;
}

export function requirePatchExplanation(
  explanation: string,
  changes: readonly AgentPatchChange[],
): string {
  const value = explanation.trim();
  if (value) return value;
  const paths = changes
    .map(({ path }) => path)
    .filter(Boolean)
    .join(", ");
  throw new Error(
    `The agent attempted to change ${paths || "a file"} without first explaining the patch, so it cannot be accepted as a valid patch activity.`,
  );
}

function runGit(
  folder: string,
  args: readonly string[],
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: folder, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve({ ok: !error, output: stdout.trim() }),
    );
  });
}

async function gitDiff(
  folder: string,
  paths: readonly string[],
): Promise<string> {
  const tracked = await runGit(folder, [
    "diff",
    "--no-ext-diff",
    "--unified=4",
    "--",
    ...paths,
  ]);
  const untracked = await Promise.all(
    paths.map(async (path) => {
      const known = await runGit(folder, [
        "ls-files",
        "--error-unmatch",
        "--",
        path,
      ]);
      if (known.ok) return "";
      const created = await runGit(folder, [
        "diff",
        "--no-ext-diff",
        "--no-index",
        "--unified=4",
        "--",
        "/dev/null",
        path,
      ]);
      return created.output;
    }),
  );
  return [tracked.output, ...untracked].filter(Boolean).join("\n");
}

export async function createPatchActivity(input: {
  folder: string;
  explanation: string;
  changes: readonly AgentPatchChange[];
  fallbackDiff?: string;
  preferFallbackDiff?: boolean;
}): Promise<AgentActivity> {
  const explanation = requirePatchExplanation(input.explanation, input.changes);
  const paths = [
    ...new Set(input.changes.map(({ path }) => path).filter(Boolean)),
  ];
  const capturedDiff =
    paths.length > 0 ? await gitDiff(input.folder, paths) : "";
  const fallbackDiff = input.fallbackDiff?.trim() ?? "";
  const diff = input.preferFallbackDiff
    ? fallbackDiff || capturedDiff
    : capturedDiff || fallbackDiff;
  return {
    type: "patch",
    explanation,
    changes: input.changes,
    diff: diff || "Diff unavailable for this edit.",
  };
}

const DIFF_CONTEXT = 4;
const MAX_CONTENT_DIFF_CELLS = 4_000_000;

type DiffOp = { type: "same" | "add" | "del"; text: string };

/** Split file content into diffable lines, dropping the phantom entry after a trailing newline. */
function contentLines(content: string): readonly string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line-based LCS diff of two file contents, guarding against huge inputs. */
function lineDiff(before: string, after: string): readonly DiffOp[] | null {
  const a = contentLines(before);
  const b = contentLines(after);
  if (a.length * b.length > MAX_CONTENT_DIFF_CELLS) return null;
  const rows = a.length + 1;
  const lcs = new Int32Array(rows * (b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * (b.length + 1) + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * (b.length + 1) + j + 1] + 1
          : Math.max(
              lcs[(i + 1) * (b.length + 1) + j],
              lcs[i * (b.length + 1) + j + 1],
            );
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (
      lcs[(i + 1) * (b.length + 1) + j] >= lcs[i * (b.length + 1) + j + 1]
    ) {
      ops.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      ops.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ type: "del", text: a[i++] });
  while (j < b.length) ops.push({ type: "add", text: b[j++] });
  return ops;
}

/**
 * Build a git-style unified diff from exact before/after file contents so the
 * sidebar can show the change an edit made instead of the current worktree
 * state. Returns "" when the contents are too large to diff or identical.
 */
export function contentDiff(
  path: string,
  before: string,
  after: string,
): string {
  if (before === after) return "";
  const ops = lineDiff(before, after);
  if (!ops) return "";
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    before === "" ? "--- /dev/null" : `--- a/${path}`,
    after === "" ? "+++ /dev/null" : `+++ b/${path}`,
  ];
  let index = 0;
  // Git numbers empty sides from 0.
  let oldLine = before === "" ? 0 : 1;
  let newLine = after === "" ? 0 : 1;
  while (index < ops.length) {
    if (ops[index].type === "same") {
      index += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }
    let first = index;
    while (
      first > 0 &&
      ops[first - 1].type === "same" &&
      index - first < DIFF_CONTEXT
    ) {
      first -= 1;
    }
    const contextBefore = index - first;
    let last = index;
    while (last < ops.length) {
      if (ops[last].type !== "same") {
        last += 1;
      } else {
        let run = 0;
        while (last + run < ops.length && ops[last + run].type === "same") {
          run += 1;
        }
        const nextChange = last + run;
        // Only bridge a run of same lines when another change follows close by.
        if (nextChange >= ops.length || run > DIFF_CONTEXT * 2) break;
        last = nextChange;
      }
    }
    let contextAfter = 0;
    while (
      last < ops.length &&
      ops[last].type === "same" &&
      contextAfter < DIFF_CONTEXT
    ) {
      last += 1;
      contextAfter += 1;
    }
    const hunk: string[] = [];
    let oldLines = 0;
    let newLines = 0;
    for (let k = first; k < last; k += 1) {
      const op = ops[k];
      if (op.type === "same") {
        hunk.push(` ${op.text}`);
        oldLines += 1;
        newLines += 1;
      } else if (op.type === "del") {
        hunk.push(`-${op.text}`);
        oldLines += 1;
      } else {
        hunk.push(`+${op.text}`);
        newLines += 1;
      }
    }
    lines.push(
      `@@ -${oldLine - contextBefore},${oldLines} +${newLine - contextBefore},${newLines} @@`,
    );
    lines.push(...hunk);
    for (let k = index; k < last; k += 1) {
      if (ops[k].type !== "add") oldLine += 1;
      if (ops[k].type !== "del") newLine += 1;
    }
    index = last;
  }
  return `${lines.join("\n")}\n`;
}

export function claudePatchChanges(
  name: string,
  input: unknown,
): readonly AgentPatchChange[] {
  if (!input || typeof input !== "object") return [];
  const value = input as Record<string, unknown>;
  const path =
    typeof value.file_path === "string"
      ? value.file_path
      : typeof value.notebook_path === "string"
        ? value.notebook_path
        : "";
  const nativeName = name.split("__").at(-1) ?? name;
  const kind =
    nativeName === "Write"
      ? "write"
      : nativeName === "Edit"
        ? "update"
        : "notebook-edit";
  return path ? [{ path, kind }] : [];
}
