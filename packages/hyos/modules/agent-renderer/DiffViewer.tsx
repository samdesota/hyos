import { For, Show, createMemo, createSignal, type Component } from "solid-js";

type DiffLineKind = "addition" | "context" | "hunk" | "metadata" | "removal";

type DiffLine = Readonly<{
  content: string;
  file: string;
  kind: DiffLineKind;
  newLine: number | null;
  oldLine: number | null;
}>;

type SourceFile = Readonly<{ path: string; content: string }>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const codeToken =
  /(\/\/.*|\/\*[\s\S]*?\*\/|#[^!].*)|(["'`](?:\\.|[^\\])*?["'`])|(\b(?:as|async|await|break|case|catch|class|const|continue|def|delete|do|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|of|package|private|protected|public|return|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\b)|(\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b)/gi;

function highlightedCode(value: string): string {
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(codeToken)) {
    const index = match.index ?? 0;
    output += escapeHtml(value.slice(cursor, index));
    const className = match[1]
      ? "syntax-comment"
      : match[2]
        ? "syntax-string"
        : match[3]
          ? "syntax-keyword"
          : "syntax-number";
    output += `<span class="${className}">${escapeHtml(match[0])}</span>`;
    cursor = index + match[0].length;
  }
  return output + escapeHtml(value.slice(cursor));
}

function displayableDiff(diff: string): string {
  if (!diff.trimStart().startsWith("{")) return diff;
  try {
    const input = JSON.parse(diff) as Record<string, unknown>;
    if (
      typeof input.file_path !== "string" ||
      typeof input.content !== "string"
    )
      return diff;
    const lines = input.content.endsWith("\n")
      ? input.content.slice(0, -1).split("\n")
      : input.content.split("\n");
    return [
      `+++ ${input.file_path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
  } catch {
    return diff;
  }
}

export function parseUnifiedDiff(diff: string): readonly DiffLine[] {
  const rows: DiffLine[] = [];
  let file = "";
  let oldLine: number | null = null;
  let newLine: number | null = null;
  for (const content of displayableDiff(diff).split("\n")) {
    const oldFile = content.match(/^--- (?:a\/)?(.+)$/);
    const newFile = content.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (oldFile && oldFile[1] !== "/dev/null") file = oldFile[1];
    if (newFile && newFile[1] !== "/dev/null") file = newFile[1];
    const hunk = content.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({
        content: "",
        file,
        kind: "hunk",
        oldLine: null,
        newLine: null,
      });
    } else if (
      oldLine !== null &&
      newLine !== null &&
      content.startsWith("+") &&
      !content.startsWith("+++")
    ) {
      rows.push({
        content: content.slice(1),
        file,
        kind: "addition",
        oldLine: null,
        newLine,
      });
      newLine += 1;
    } else if (
      oldLine !== null &&
      newLine !== null &&
      content.startsWith("-") &&
      !content.startsWith("---")
    ) {
      rows.push({
        content: content.slice(1),
        file,
        kind: "removal",
        oldLine,
        newLine: null,
      });
      oldLine += 1;
    } else if (
      oldLine !== null &&
      newLine !== null &&
      (content.startsWith(" ") || content === "")
    ) {
      rows.push({
        content: content.slice(content.startsWith(" ") ? 1 : 0),
        file,
        kind: "context",
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
    } else {
      rows.push({
        content,
        file,
        kind: "metadata",
        oldLine: null,
        newLine: null,
      });
    }
  }
  return rows;
}

function rowsForPath(
  rows: readonly DiffLine[],
  requestedPath: string,
): readonly DiffLine[] {
  return rows.filter(
    (row) =>
      row.file === requestedPath ||
      requestedPath.endsWith(`/${row.file}`) ||
      row.file.endsWith(`/${requestedPath}`),
  );
}

export function expandToFullFile(
  source: SourceFile,
  patchRows: readonly DiffLine[],
): readonly DiffLine[] {
  const relevant = rowsForPath(patchRows, source.path).filter(
    (row) => row.kind !== "metadata" && row.kind !== "hunk",
  );
  const additions = new Set(
    relevant.flatMap((row) =>
      row.kind === "addition" && row.newLine !== null ? [row.newLine] : [],
    ),
  );
  const removals = new Map<number, DiffLine[]>();
  for (const [index, row] of relevant.entries()) {
    if (row.kind !== "removal") continue;
    const nextLine = relevant
      .slice(index + 1)
      .find((candidate) => candidate.newLine !== null)?.newLine;
    const previousLine = relevant
      .slice(0, index)
      .reverse()
      .find((candidate) => candidate.newLine !== null)?.newLine;
    const anchor = nextLine ?? (previousLine ?? 0) + 1;
    removals.set(anchor, [...(removals.get(anchor) ?? []), row]);
  }
  const sourceLines = source.content.endsWith("\n")
    ? source.content.slice(0, -1).split("\n")
    : source.content
      ? source.content.split("\n")
      : [];
  const result: DiffLine[] = [];
  for (let lineNumber = 1; lineNumber <= sourceLines.length; lineNumber += 1) {
    result.push(...(removals.get(lineNumber) ?? []));
    const exact = relevant.find(
      (row) => row.kind === "context" && row.newLine === lineNumber,
    );
    const preceding = [...relevant]
      .reverse()
      .find(
        (row) =>
          row.kind === "context" &&
          row.newLine !== null &&
          row.newLine < lineNumber &&
          row.oldLine !== null,
      );
    let oldLine: number | null = lineNumber;
    if (additions.has(lineNumber)) oldLine = null;
    else if (exact?.oldLine !== null && exact?.oldLine !== undefined) {
      oldLine = exact.oldLine;
    } else if (
      preceding?.oldLine !== null &&
      preceding?.oldLine !== undefined &&
      preceding.newLine !== null
    ) {
      oldLine = lineNumber + preceding.oldLine - preceding.newLine;
    }
    result.push({
      content: sourceLines[lineNumber - 1],
      file: source.path,
      kind: additions.has(lineNumber) ? "addition" : "context",
      oldLine,
      newLine: lineNumber,
    });
  }
  result.push(...(removals.get(sourceLines.length + 1) ?? []));
  return result;
}

const DiffRows: Component<{ rows: readonly DiffLine[] }> = (props) => (
  <For each={props.rows}>
    {(line) => (
      <Show when={line.kind !== "metadata"}>
        <Show
          when={line.kind !== "hunk"}
          fallback={<div class="diff-hunk-gap" aria-hidden="true" />}
        >
          <div class={`diff-line ${line.kind}`} role="row">
            <span class="diff-line-number old" role="cell">
              {line.oldLine ?? ""}
            </span>
            <span class="diff-line-number new" role="cell">
              {line.newLine ?? ""}
            </span>
            <span class="diff-marker" aria-hidden="true">
              {line.kind === "addition"
                ? "+"
                : line.kind === "removal"
                  ? "−"
                  : " "}
            </span>
            <code
              class="diff-code"
              role="cell"
              innerHTML={highlightedCode(line.content)}
            />
          </div>
        </Show>
      </Show>
    )}
  </For>
);

export const DiffViewer: Component<{
  diff: string;
  paths: readonly string[];
  loadFile(path: string): Promise<SourceFile>;
}> = (props) => {
  const [unlocked, setUnlocked] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [sources, setSources] = createSignal<readonly SourceFile[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const patchRows = createMemo(() => parseUnifiedDiff(props.diff));
  const visibleRows = createMemo(() =>
    sources().length > 0
      ? sources().flatMap((source) => expandToFullFile(source, patchRows()))
      : patchRows(),
  );

  const unlock = async (): Promise<void> => {
    if (unlocked()) return;
    setUnlocked(true);
    setLoading(true);
    setError(null);
    try {
      setSources(
        await Promise.all([...new Set(props.paths)].map(props.loadFile)),
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  };
  const lock = (event: MouseEvent): void => {
    event.stopPropagation();
    setUnlocked(false);
    setSources([]);
    setError(null);
  };

  return (
    <div
      class="diff-viewer"
      classList={{ locked: !unlocked(), unlocked: unlocked() }}
      role="table"
      aria-label="Patch diff"
      onClick={() => void unlock()}
    >
      <div class="diff-toolbar">
        <span>
          {loading()
            ? "Loading full file…"
            : unlocked()
              ? "Full file"
              : "Click to browse full file"}
        </span>
        <Show when={unlocked()}>
          <button type="button" aria-label="Lock diff scrolling" onClick={lock}>
            Lock
          </button>
        </Show>
      </div>
      <div class="diff-body">
        <DiffRows rows={visibleRows()} />
      </div>
      <Show when={error()}>
        {(message) => <div class="diff-error">{message()}</div>}
      </Show>
    </div>
  );
};
