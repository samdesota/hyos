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
    });
    let output = "";
    const append = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    const abort = () => child.kill("SIGTERM");
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
      const requestedPath = requiredString(input, "filePath");
      await editFile(folder, {
        file_path: requestedPath,
        old_string: requiredString(input, "oldString"),
        new_string: typeof input.newString === "string" ? input.newString : "",
        replace_all: input.replaceAll === true,
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
      const requestedPath = requiredString(input, "filePath");
      await writeWholeFile(folder, {
        file_path: requestedPath,
        content: typeof input.content === "string" ? input.content : "",
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
