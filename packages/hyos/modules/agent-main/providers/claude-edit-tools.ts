import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const editInputSchema = {
  file_path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
  explanation: z.string().trim().min(1),
};

export const writeInputSchema = {
  file_path: z.string().min(1),
  content: z.string(),
  explanation: z.string().trim().min(1),
};

type EditInput = Readonly<{
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  explanation: string;
}>;

type WriteInput = Readonly<{
  file_path: string;
  content: string;
  explanation: string;
}>;

function workspacePath(folder: string, requestedPath: string): string {
  const root = path.resolve(folder);
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`File is outside the workspace: ${requestedPath}`);
  }
  return resolved;
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) >= 0) {
    count += 1;
    offset += search.length;
  }
  return count;
}

function result(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

export async function editFile(
  folder: string,
  input: EditInput,
): Promise<CallToolResult> {
  const file = workspacePath(folder, input.file_path);
  const content = await readFile(file, "utf8");
  const occurrences = countOccurrences(content, input.old_string);
  if (occurrences === 0) {
    throw new Error(`old_string was not found in ${input.file_path}`);
  }
  if (!input.replace_all && occurrences > 1) {
    throw new Error(
      `old_string appears ${occurrences} times in ${input.file_path}; provide more context or set replace_all.`,
    );
  }
  const updated = input.replace_all
    ? content.split(input.old_string).join(input.new_string)
    : content.replace(input.old_string, input.new_string);
  await writeFile(file, updated);
  return result(`Updated ${input.file_path}: ${input.explanation}`);
}

export async function writeWholeFile(
  folder: string,
  input: WriteInput,
): Promise<CallToolResult> {
  const file = workspacePath(folder, input.file_path);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, input.content);
  return result(`Wrote ${input.file_path}: ${input.explanation}`);
}
