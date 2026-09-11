import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { editFile, writeWholeFile } from "./claude-edit-tools.js";

const MAX_OUTPUT = 60_000;
const MAX_READ_BYTES = 50 * 1024;

export type ToolResult = Readonly<{
  output: string;
  paths?: readonly string[];
}>;

export type OpenCodeTool = Readonly<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: "read" | "command" | "edit";
  execute(
    folder: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}>;

function workspacePath(folder: string, requestedPath: string): string {
  const root = path.resolve(folder);
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the workspace: ${requestedPath}`);
  }
  return resolved;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

/**
 * Read a string argument, falling back to a snake_case alias. Models
 * occasionally emit Claude-style `old_string`/`new_string` names instead of
 * the camelCase parameters this toolset declares; accept both so a valid edit
 * does not fail with "oldString is required".
 */
function stringArg(
  input: Record<string, unknown>,
  key: string,
  alias?: string,
): string | undefined {
  const value = input[key] ?? (alias === undefined ? undefined : input[alias]);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Kill a spawned child and its whole process tree. The child is spawned as a
 * process-group leader (`detached: true`), so a negative pid signals every
 * descendant; escalating to SIGKILL guarantees cleanup even if SIGTERM is
 * ignored. Without this, grandchildren keep the stdio pipes open, the `close`
 * event never fires, and an aborted command hangs the agent run forever.
 */
function killTree(child: import("node:child_process").ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const signalGroup = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pid, name);
    } catch {
      // Process group already gone.
    }
    try {
      child.kill(name);
    } catch {
      // Child already gone.
    }
  };
  signalGroup("SIGTERM");
  const escalate = setTimeout(() => signalGroup("SIGKILL"), 2_000);
  child.once("close", () => clearTimeout(escalate));
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  timeout = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    const append = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => killTree(child), timeout);
    const abort = () => {
      killTree(child);
      // Settle immediately so a stray descendant holding the stdio pipes
      // open can never block the run after the caller cancelled.
      if (!signal.aborted) return;
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const result = output.slice(0, MAX_OUTPUT).trimEnd();
      if (signal.aborted) reject(new Error("Cancelled"));
      else if (code === 0 || (command === "rg" && code === 1)) resolve(result);
      else reject(new Error(result || `${command} exited with code ${code}`));
    });
  });
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const openCodeTools: readonly OpenCodeTool[] = [
  {
    name: "read",
    description:
      "Read a file or list a directory. File output is line-numbered; use offset and limit for large files.",
    category: "read",
    parameters: objectSchema(
      {
        filePath: {
          type: "string",
          description: "Absolute path to the file or directory",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "First line to read (1-indexed)",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum lines (default 2000)",
        },
      },
      ["filePath"],
    ),
    async execute(folder, input) {
      const file = workspacePath(folder, requiredString(input, "filePath"));
      const info = await stat(file);
      if (info.isDirectory()) {
        const entries = await readdir(file, { withFileTypes: true });
        return {
          output: entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
            .join("\n"),
        };
      }
      const start =
        typeof input.offset === "number" ? Math.max(1, input.offset) : 1;
      const limit =
        typeof input.limit === "number" ? Math.max(1, input.limit) : 2_000;
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      const selected = lines.slice(start - 1, start - 1 + limit);
      return {
        output: selected
          .map(
            (line, index) =>
              `${String(start + index).padStart(5, "0")}| ${line}`,
          )
          .join("\n")
          .slice(0, MAX_READ_BYTES),
      };
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern.",
    category: "read",
    parameters: objectSchema(
      {
        pattern: {
          type: "string",
          description: "Glob pattern such as **/*.ts",
        },
        path: {
          type: "string",
          description: "Directory to search; defaults to the workspace",
        },
      },
      ["pattern"],
    ),
    async execute(folder, input, signal) {
      const cwd = workspacePath(
        folder,
        typeof input.path === "string" ? input.path : ".",
      );
      return {
        output: await run(
          "rg",
          ["--files", "-g", requiredString(input, "pattern")],
          cwd,
          signal,
        ),
      };
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with a regular expression using ripgrep.",
    category: "read",
    parameters: objectSchema(
      {
        pattern: {
          type: "string",
          description: "Regular expression to search for",
        },
        path: {
          type: "string",
          description: "Directory or file to search; defaults to the workspace",
        },
        include: {
          type: "string",
          description: "Optional file glob such as *.ts",
        },
      },
      ["pattern"],
    ),
    async execute(folder, input, signal) {
      const target = workspacePath(
        folder,
        typeof input.path === "string" ? input.path : ".",
      );
      const args = [
        "-n",
        "--hidden",
        "--glob",
        "!.git",
        requiredString(input, "pattern"),
        target,
      ];
      if (typeof input.include === "string")
        args.splice(4, 0, "--glob", input.include);
      return { output: await run("rg", args, folder, signal) };
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command in the workspace. Use this for builds, tests, and other terminal operations, not for reading or writing files when a dedicated tool applies.",
    category: "command",
    parameters: objectSchema(
      {
        command: { type: "string", description: "Shell command to execute" },
        timeout: {
          type: "integer",
          minimum: 1,
          maximum: 600000,
          description: "Timeout in milliseconds",
        },
        description: {
          type: "string",
          description: "Short description of what the command does",
        },
      },
      ["command", "description"],
    ),
    async execute(folder, input, signal) {
      const timeout =
        typeof input.timeout === "number" ? input.timeout : 120_000;
      return {
        output: await run(
          "/bin/zsh",
          ["-lc", requiredString(input, "command")],
          folder,
          signal,
          timeout,
        ),
      };
    },
  },
  {
    name: "edit",
    description:
      "Replace exact text in a file. Provide enough surrounding text to make oldString unique and explain what the change does and why.",
    category: "edit",
    parameters: objectSchema(
      {
        filePath: {
          type: "string",
          description: "Absolute path to the file to modify",
        },
        oldString: { type: "string", description: "Exact text to replace" },
        newString: { type: "string", description: "Replacement text" },
        replaceAll: {
          type: "boolean",
          description: "Replace every occurrence (default false)",
        },
        explanation: {
          type: "string",
          description: "Concise explanation of what this patch does and why",
        },
      },
      ["filePath", "oldString", "newString", "explanation"],
    ),
    async execute(folder, input) {
      const requestedPath = stringArg(input, "filePath", "file_path");
      if (requestedPath === undefined) throw new Error("filePath is required");
      const oldString = stringArg(input, "oldString", "old_string");
      if (oldString === undefined) throw new Error("oldString is required");
      const newString = input.newString ?? input.new_string;
      await editFile(folder, {
        file_path: requestedPath,
        old_string: oldString,
        new_string: typeof newString === "string" ? newString : "",
        replace_all: input.replaceAll === true || input.replace_all === true,
        explanation: requiredString(input, "explanation"),
      });
      return { output: "Edit applied successfully.", paths: [requestedPath] };
    },
  },
  {
    name: "write",
    description:
      "Write complete content to a file. Prefer edit for existing files and explain what the change does and why.",
    category: "edit",
    parameters: objectSchema(
      {
        content: { type: "string", description: "Complete file content" },
        filePath: {
          type: "string",
          description: "Absolute path to the file to write",
        },
        explanation: {
          type: "string",
          description: "Concise explanation of what this patch does and why",
        },
      },
      ["content", "filePath", "explanation"],
    ),
    async execute(folder, input) {
      const requestedPath = stringArg(input, "filePath", "file_path");
      if (requestedPath === undefined) throw new Error("filePath is required");
      const content = input.content ?? input.file_content;
      await writeWholeFile(folder, {
        file_path: requestedPath,
        content: typeof content === "string" ? content : "",
        explanation: requiredString(input, "explanation"),
      });
      return { output: "Wrote file successfully.", paths: [requestedPath] };
    },
  },
];

export function openCodeTool(name: string): OpenCodeTool {
  const result = openCodeTools.find((tool) => tool.name === name);
  if (!result) throw new Error(`Unknown tool: ${name}`);
  return result;
}
