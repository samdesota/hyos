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
