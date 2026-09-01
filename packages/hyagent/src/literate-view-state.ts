interface StoredLiterateViewState {
  scrollTop: number;
  collapsedFiles: string[];
}

const STORAGE_PREFIX = "hyagent:literate-view:v1:";

function storageKey(sessionId: string, diffId: string): string {
  return `${STORAGE_PREFIX}${sessionId}:${diffId}`;
}

function read(sessionId: string, diffId: string): StoredLiterateViewState {
  try {
    const value = localStorage.getItem(storageKey(sessionId, diffId));
    if (!value) return { scrollTop: 0, collapsedFiles: [] };
    const parsed = JSON.parse(value) as Partial<StoredLiterateViewState>;
    return {
      scrollTop:
        typeof parsed.scrollTop === "number" && parsed.scrollTop >= 0
          ? parsed.scrollTop
          : 0,
      collapsedFiles: Array.isArray(parsed.collapsedFiles)
        ? parsed.collapsedFiles.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    };
  } catch {
    return { scrollTop: 0, collapsedFiles: [] };
  }
}

function write(
  sessionId: string,
  diffId: string,
  state: StoredLiterateViewState,
): void {
  try {
    localStorage.setItem(storageKey(sessionId, diffId), JSON.stringify(state));
  } catch {
    // View state is a convenience; storage restrictions should not break work.
  }
}

export function literateScrollTop(sessionId: string, diffId: string): number {
  return read(sessionId, diffId).scrollTop;
}

export function saveLiterateScrollTop(
  sessionId: string,
  diffId: string,
  scrollTop: number,
): void {
  write(sessionId, diffId, {
    ...read(sessionId, diffId),
    scrollTop: Math.max(0, scrollTop),
  });
}

export function literateFileCollapsed(
  sessionId: string,
  diffId: string,
  fileKey: string,
): boolean {
  return read(sessionId, diffId).collapsedFiles.includes(fileKey);
}

export function saveLiterateFileCollapsed(
  sessionId: string,
  diffId: string,
  fileKey: string,
  collapsed: boolean,
): void {
  const state = read(sessionId, diffId);
  const files = new Set(state.collapsedFiles);
  if (collapsed) files.add(fileKey);
  else files.delete(fileKey);
  write(sessionId, diffId, { ...state, collapsedFiles: [...files] });
}
