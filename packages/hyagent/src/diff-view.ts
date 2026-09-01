export type CodeRow = {
  kind: "context" | "added" | "removed" | "gap";
  code: string;
  oldLine?: number;
  newLine?: number;
};

export interface PatchFileSection {
  path: string;
  patch: string;
}

function sectionPath(patch: string, fallback: string) {
  return (
    patch.match(/^\+\+\+ b\/(.+)$/m)?.[1] ??
    patch.match(/^--- a\/(.+)$/m)?.[1] ??
    fallback
  );
}

export function splitPatchFiles(patch: string): PatchFileSection[] {
  const headers = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  if (headers.length === 0) {
    return [{ path: sectionPath(patch, "Changed file"), patch }];
  }
  return headers.map((header, index) => {
    const start = header.index!;
    const end = headers[index + 1]?.index ?? patch.length;
    const section = patch.slice(start, end);
    return {
      path: sectionPath(section, header[2]!),
      patch: section,
    };
  });
}

export function patchStats(patch: string) {
  const lines = patch.split("\n");
  return {
    added: lines.filter(
      (line) => line.startsWith("+") && !line.startsWith("+++"),
    ).length,
    removed: lines.filter(
      (line) => line.startsWith("-") && !line.startsWith("---"),
    ).length,
  };
}

export function diffRows(patch: string): CodeRow[] {
  const rows: CodeRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      const nextOldLine = Number(hunk[1]);
      const nextNewLine = Number(hunk[2]);
      if (inHunk && nextOldLine > oldLine) {
        rows.push({
          kind: "gap",
          code: `${nextOldLine - oldLine} unchanged lines`,
        });
      }
      oldLine = nextOldLine;
      newLine = nextNewLine;
      inHunk = true;
      continue;
    }
    if (!inHunk || line === "" || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      rows.push({ kind: "added", code: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "removed", code: line.slice(1), oldLine });
      oldLine += 1;
    } else {
      rows.push({
        kind: "context",
        code: line.startsWith(" ") ? line.slice(1) : line,
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

export function fullFileFromAddedPatch(patch: string): string | undefined {
  if (!/^--- \/dev\/null$/m.test(patch)) return undefined;
  const rows = diffRows(patch).filter(
    (row) => row.kind === "added" || row.kind === "context",
  );
  return `${rows.map((row) => row.code).join("\n")}\n`;
}
