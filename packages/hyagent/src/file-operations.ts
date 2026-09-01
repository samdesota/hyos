import { z } from "zod";

export const fileOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_file"),
    path: z.string().min(1).max(1_000),
    content: z.string().max(500_000),
  }),
  z.object({
    type: z.literal("replace_text"),
    path: z.string().min(1).max(1_000),
    before: z.string().min(1).max(500_000),
    after: z.string().max(500_000),
  }),
  z.object({
    type: z.literal("delete_file"),
    path: z.string().min(1).max(1_000),
  }),
]);

export type FileOperation = z.infer<typeof fileOperationSchema>;

function operationsFromApplyPatch(patch: string): FileOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const headers = lines.flatMap((line, index) =>
    /^\*\*\* (Add|Update|Delete) File: /.test(line) ? [index] : [],
  );
  const operations: FileOperation[] = [];
  for (let sectionIndex = 0; sectionIndex < headers.length; sectionIndex += 1) {
    const start = headers[sectionIndex]!;
    const end =
      headers[sectionIndex + 1] ??
      lines.findIndex(
        (line, index) => index > start && line === "*** End Patch",
      );
    const effectiveEnd = end < 0 ? lines.length : end;
    const match = lines[start]!.match(
      /^\*\*\* (Add|Update|Delete) File: (.+)$/,
    )!;
    const action = match[1]!;
    const path = match[2]!;
    if (action === "Delete") {
      operations.push({ type: "delete_file", path });
      continue;
    }
    if (action === "Add") {
      const content = lines
        .slice(start + 1, effectiveEnd)
        .filter((line) => line.startsWith("+"))
        .map((line) => line.slice(1))
        .join("\n");
      operations.push({
        type: "create_file",
        path,
        content: content ? `${content}\n` : "",
      });
      continue;
    }
    const section = lines.slice(start + 1, effectiveEnd);
    const hunks = section.some((line) => line.startsWith("@@"))
      ? section.reduce<string[][]>((result, line) => {
          if (line.startsWith("@@")) result.push([]);
          else (result.at(-1) ?? (result.push([]), result.at(-1)!)).push(line);
          return result;
        }, [])
      : [section];
    for (const hunk of hunks.filter((candidate) => candidate.length > 0)) {
      const before = hunk
        .filter((line) => line.startsWith("-") || line.startsWith(" "))
        .map((line) => line.slice(1))
        .join("\n");
      const after = hunk
        .filter((line) => line.startsWith("+") || line.startsWith(" "))
        .map((line) => line.slice(1))
        .join("\n");
      if (!before)
        throw new Error(`Legacy update for ${path} has no replaceable text`);
      operations.push({ type: "replace_text", path, before, after });
    }
  }
  if (operations.length === 0)
    throw new Error("Legacy apply_patch has no file operations");
  return operations;
}

function cleanPath(value: string): string | null {
  const path = value.trim().split("\t", 1)[0]!;
  if (path === "/dev/null") return null;
  return path.replace(/^[ab]\//, "");
}

function bodyLines(lines: readonly string[], start: number, end: number) {
  const result: string[] = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("\\ No newline")) continue;
    if (/^(diff --git |index |new file mode |deleted file mode )/.test(line)) {
      continue;
    }
    if (line.startsWith("@@ ")) continue;
    if (/^[ +\-]/.test(line)) result.push(line);
  }
  return result;
}

/** Convert persisted legacy unified diffs without trusting their hunk counts. */
export function operationsFromLegacyPatch(patch: string): FileOperation[] {
  if (patch.startsWith("*** Begin Patch"))
    return operationsFromApplyPatch(patch);
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const headers: number[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      lines[index]!.startsWith("--- ") &&
      lines[index + 1]!.startsWith("+++ ")
    ) {
      headers.push(index);
    }
  }
  if (headers.length === 0) {
    throw new Error("Legacy patch has no file headers");
  }

  const operations: FileOperation[] = [];
  for (let sectionIndex = 0; sectionIndex < headers.length; sectionIndex += 1) {
    const start = headers[sectionIndex]!;
    const end = headers[sectionIndex + 1] ?? lines.length;
    const oldPath = cleanPath(lines[start]!.slice(4));
    const newPath = cleanPath(lines[start + 1]!.slice(4));
    const path = newPath ?? oldPath;
    if (!path) throw new Error("Legacy patch file has no path");
    const section = bodyLines(lines, start + 2, end);

    if (oldPath === null) {
      const content = section
        .filter((line) => line.startsWith("+") || line.startsWith(" "))
        .map((line) => line.slice(1))
        .join("\n");
      operations.push({
        type: "create_file",
        path,
        content: content.length > 0 ? `${content}\n` : "",
      });
      continue;
    }
    if (newPath === null) {
      operations.push({ type: "delete_file", path });
      continue;
    }

    let hunkStart = start + 2;
    while (hunkStart < end) {
      while (hunkStart < end && !lines[hunkStart]!.startsWith("@@ "))
        hunkStart += 1;
      if (hunkStart >= end) break;
      let hunkEnd = hunkStart + 1;
      while (hunkEnd < end && !lines[hunkEnd]!.startsWith("@@ ")) hunkEnd += 1;
      const hunk = bodyLines(lines, hunkStart + 1, hunkEnd);
      const before = hunk
        .filter((line) => line.startsWith("-") || line.startsWith(" "))
        .map((line) => line.slice(1))
        .join("\n");
      const after = hunk
        .filter((line) => line.startsWith("+") || line.startsWith(" "))
        .map((line) => line.slice(1))
        .join("\n");
      if (before.length === 0) {
        throw new Error(
          `Legacy modification for ${path} has no replaceable text`,
        );
      }
      operations.push({ type: "replace_text", path, before, after });
      hunkStart = hunkEnd;
    }
  }
  return operations;
}

export function operationPaths(operations: readonly FileOperation[]): string[] {
  return [...new Set(operations.map((operation) => operation.path))];
}

function prefixed(content: string, prefix: string): string {
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalized === ""
    ? ""
    : normalized
        .split("\n")
        .map((line) => `${prefix}${line}`)
        .join("\n");
}

/** A review rendering only; this output is never replayed. */
export function renderOperationsAsPatch(
  operations: readonly FileOperation[],
): string {
  return operations
    .map((operation) => {
      if (operation.type === "create_file") {
        const count =
          operation.content === ""
            ? 0
            : operation.content.replace(/\n$/, "").split("\n").length;
        return [
          `--- /dev/null`,
          `+++ b/${operation.path}`,
          `@@ -0,0 +1,${count} @@`,
          prefixed(operation.content, "+"),
        ]
          .filter(Boolean)
          .join("\n");
      }
      if (operation.type === "delete_file") {
        return `--- a/${operation.path}\n+++ /dev/null\n@@ -1,0 +0,0 @@`;
      }
      const before = operation.before.split("\n");
      const after = operation.after === "" ? [] : operation.after.split("\n");
      let prefix = 0;
      while (
        prefix < before.length &&
        prefix < after.length &&
        before[prefix] === after[prefix]
      ) {
        prefix += 1;
      }
      let suffix = 0;
      while (
        suffix < before.length - prefix &&
        suffix < after.length - prefix &&
        before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
      ) {
        suffix += 1;
      }
      const contextBefore = before.slice(0, prefix);
      const removed = before.slice(prefix, before.length - suffix);
      const added = after.slice(prefix, after.length - suffix);
      const contextAfter =
        suffix === 0 ? [] : before.slice(before.length - suffix);
      return [
        `--- a/${operation.path}`,
        `+++ b/${operation.path}`,
        `@@ -1,${before.length} +1,${after.length} @@`,
        ...contextBefore.map((line) => ` ${line}`),
        ...removed.map((line) => `-${line}`),
        ...added.map((line) => `+${line}`),
        ...contextAfter.map((line) => ` ${line}`),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}
