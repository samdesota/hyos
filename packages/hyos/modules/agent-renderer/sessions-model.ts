import type {
  AgentActivity,
  AgentMessage,
  AgentPlan,
  AgentPlanTask,
  AgentSessionSummary,
} from "../../capabilities/agent.js";

export type TimelineEntry =
  | Readonly<{ type: "message"; message: AgentMessage }>
  | Readonly<{ type: "tools"; messages: readonly AgentMessage[] }>
  | Readonly<{
      type: "work";
      entries: readonly TimelineEntry[];
      startedAt: Date;
      endedAt: Date;
    }>;

const isWorkItem = (entry: TimelineEntry): boolean =>
  entry.type === "tools" ||
  (entry.type === "message" && entry.message.activity?.type === "commentary");

const firstCreatedAt = (entry: TimelineEntry): Date =>
  entry.type === "tools"
    ? entry.messages[0].createdAt
    : entry.type === "message"
      ? entry.message.createdAt
      : entry.startedAt;

export function workPaneLabel(
  startedAt: Date,
  endedAt: Date,
  now: Date = new Date(),
): string {
  const seconds = Math.max(
    1,
    Math.round(((endedAt ?? now).getTime() - startedAt.getTime()) / 1000),
  );
  if (seconds < 60) return `Worked for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `Worked for ${minutes}m ${rest}s` : `Worked for ${minutes}m`;
}

/** Collapse each finished run's tool/commentary activity into a summary pane. */
export function collapseWorkRuns(
  entries: readonly TimelineEntry[],
): TimelineEntry[] {
  const result: TimelineEntry[] = [];
  let pending: TimelineEntry[] = [];
  const flush = (final?: AgentMessage) => {
    if (!pending.length) return;
    const canCollapse =
      final !== undefined && final.status !== "streaming" && !final.lastError;
    if (canCollapse) {
      result.push({
        type: "work",
        entries: pending,
        startedAt: firstCreatedAt(pending[0]),
        endedAt: final.createdAt,
      });
    } else {
      result.push(...pending);
    }
    pending = [];
  };
  for (const entry of entries) {
    if (isWorkItem(entry)) {
      pending.push(entry);
      continue;
    }
    flush(entry.type === "message" ? entry.message : undefined);
    result.push(entry);
  }
  flush();
  return result;
}

export function timelineEntries(
  messages: readonly AgentMessage[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const ordered = [...messages].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id),
  );
  for (const message of ordered) {
    if (message.activity?.type === "patch") continue;
    if (
      !message.content &&
      message.role === "assistant" &&
      !message.lastError &&
      message.status !== "streaming"
    )
      continue;
    if (message.activity?.type === "tool") {
      const last = entries.at(-1);
      if (last?.type === "tools") {
        entries[entries.length - 1] = {
          type: "tools",
          messages: [...last.messages, message],
        };
      } else {
        entries.push({ type: "tools", messages: [message] });
      }
    } else if (message.activity?.type === "commentary") {
      const last = entries.at(-1);
      if (
        last?.type === "message" &&
        last.message.activity?.type === "commentary"
      ) {
        // The backend streams one thinking run as separate commentary
        // messages; merge consecutive ones so the run renders as a single
        // capped block: joined text, the newest fragment's streaming status,
        // and the earliest fragment's createdAt (kept from the merged entry)
        // for timeline ordering.
        entries[entries.length - 1] = {
          type: "message",
          message: {
            ...last.message,
            id: message.id,
            status: message.status,
            activity: {
              type: "commentary",
              text: `${last.message.activity.text}\n\n${message.activity.text}`,
            },
            updatedAt: message.updatedAt,
          },
        };
      } else {
        entries.push({ type: "message", message });
      }
    } else {
      entries.push({ type: "message", message });
    }
  }
  return entries;
}

const sameActivity = (
  a: AgentActivity | null,
  b: AgentActivity | null,
): boolean => {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "commentary" && b.type === "commentary")
    return a.text === b.text;
  if (a.type === "tool" && b.type === "tool")
    return a.label === b.label && a.detail === b.detail;
  if (a.type === "patch" && b.type === "patch")
    return a.explanation === b.explanation && a.diff === b.diff;
  return false;
};

/**
 * Value equality for timeline entries. Derived entries are rebuilt from the
 * message list on every change; this lets the renderer reuse the previous
 * entry objects (and their group wrappers) when nothing visible changed, so
 * Solid's reference-keyed `<For>` only remounts the rows that really moved.
 */
export function sameTimelineEntry(
  a: TimelineEntry | undefined,
  b: TimelineEntry | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "tools" && b.type === "tools")
    return (
      a.messages.length === b.messages.length &&
      a.messages.every((message, i) => message === b.messages[i])
    );
  if (a.type === "work" && b.type === "work")
    return (
      a.startedAt.getTime() === b.startedAt.getTime() &&
      a.endedAt.getTime() === b.endedAt.getTime() &&
      a.entries.length === b.entries.length &&
      a.entries.every((entry, i) => sameTimelineEntry(entry, b.entries[i]))
    );
  if (a.type === "message" && b.type === "message") {
    const { message: x } = a;
    const { message: y } = b;
    if (x === y) return true;
    return (
      x.id === y.id &&
      x.role === y.role &&
      x.status === y.status &&
      x.lastError === y.lastError &&
      x.content === y.content &&
      x.updatedAt.getTime() === y.updatedAt.getTime() &&
      sameActivity(x.activity ?? null, y.activity ?? null)
    );
  }
  return false;
}

/**
 * Return `next` with each entry replaced by the previous run's identical
 * entry object, so downstream reference-keyed `<For>` lists stay stable.
 */
export function shareTimelineEntries(
  prev: readonly TimelineEntry[] | undefined,
  next: readonly TimelineEntry[],
): TimelineEntry[] {
  if (!prev) return [...next];
  return next.map((entry, i) =>
    sameTimelineEntry(prev[i], entry) ? prev[i]! : entry,
  );
}

export function patchEntries(
  messages: readonly AgentMessage[],
): readonly AgentMessage[] {
  return [...messages]
    .filter((message) => message.activity?.type === "patch")
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
}

/**
 * Index of the timeline entry the plan panel belongs under — the final
 * assistant response — or -1 when there is nothing to attach it to.
 * Streaming turns attach nothing: thinking/commentary messages stream in
 * as assistant messages too, so matching them would move the panel around
 * mid-run.
 */
export function planPanelIndex(entries: readonly TimelineEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.status !== "streaming"
    ) {
      return index;
    }
  }
  return -1;
}

/** The first pending plan task, or null when every task is done. */
export function nextPlanTask(
  tasks: readonly AgentPlanTask[],
): AgentPlanTask | null {
  return tasks.find((task) => !task.done) ?? null;
}

/** The user response that drives the next "implement next" iteration. */
export function implementNextPrompt(
  index: number,
  task: AgentPlanTask,
): string {
  return `Implement next: complete and verify only task ${index + 1} of the plan — "${task.text}". Do not work on any other task or expand the plan, and end with the updated hyos-plan block marking this task done.`;
}

export function partitionSessions(
  sessions: readonly AgentSessionSummary[],
): Readonly<{
  active: readonly AgentSessionSummary[];
  archived: readonly AgentSessionSummary[];
}> {
  const active: AgentSessionSummary[] = [];
  const archived: AgentSessionSummary[] = [];
  for (const session of sessions) {
    (session.archivedAt ? archived : active).push(session);
  }
  return { active, archived };
}

export type SessionFolderGroup = Readonly<{
  folder: string;
  label: string;
  parentPath: string | null;
  sessions: readonly AgentSessionSummary[];
}>;

/**
 * The folder a session is grouped under in the sidebar: worktree sessions
 * report their origin folder so they never spawn duplicate folder entries.
 */
export function sessionGroupFolder(session: AgentSessionSummary): string {
  return session.originFolder ?? session.folder;
}

/** Group a newest-first session list, preserving group and session order.
 * Call separately for active and archived sessions after partitioning.
 */
export function groupSessionsByFolder(
  sessions: readonly AgentSessionSummary[],
): readonly SessionFolderGroup[] {
  const folders = new Map<string, AgentSessionSummary[]>();
  for (const session of sessions) {
    const key = sessionGroupFolder(session);
    const group = folders.get(key);
    if (group) group.push(session);
    else folders.set(key, [session]);
  }
  const labels = new Map<string, number>();
  const labelFor = (folder: string) =>
    folder ? folderName(folder) || folder : "No project folder";
  for (const folder of folders.keys()) {
    const label = labelFor(folder);
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  return Array.from(folders, ([folder, groupedSessions]) => {
    const label = labelFor(folder);
    const trimmed = folder.replace(/\/+$/, "");
    const separator = trimmed.lastIndexOf("/");
    return {
      folder,
      label,
      parentPath:
        folder && labels.get(label)! > 1
          ? separator === -1
            ? "."
            : trimmed.slice(0, separator) || "/"
          : null,
      sessions: groupedSessions,
    };
  });
}

/**
 * Order folder groups by the saved manual folder order: saved folders keep
 * their order, unsaved (new) folders keep their group order at the end.
 */
export function orderedFolderGroups(
  groups: readonly SessionFolderGroup[],
  savedOrder: readonly string[] | null,
): readonly SessionFolderGroup[] {
  if (!savedOrder || savedOrder.length === 0) return groups;
  const byFolder = new Map(groups.map((group) => [group.folder, group]));
  const ordered: SessionFolderGroup[] = [];
  const seen = new Set<string>();
  for (const folder of savedOrder) {
    const group = byFolder.get(folder);
    if (group && !seen.has(folder)) {
      seen.add(folder);
      ordered.push(group);
    }
  }
  for (const group of groups) {
    if (!seen.has(group.folder)) {
      seen.add(group.folder);
      ordered.push(group);
    }
  }
  return ordered;
}

/**
 * Move a dragged session within its folder group without breaking folder
 * contiguity: returns the full new active-session id order (ready for the
 * host's reorder-sessions command), or null when the drop is a no-op — same
 * row, unknown id, or a cross-folder drag.
 */
export function reorderWithinFolder(
  active: readonly AgentSessionSummary[],
  draggedId: string,
  targetId: string,
): readonly string[] | null {
  if (draggedId === targetId) return null;
  const dragged = active.find((session) => session.id === draggedId);
  const target = active.find((session) => session.id === targetId);
  if (!dragged || !target) return null;
  const draggedKey = sessionGroupFolder(dragged);
  const targetKey = sessionGroupFolder(target);
  if (draggedKey !== targetKey) return null;
  const folderSessions = active.filter(
    (session) => sessionGroupFolder(session) === targetKey,
  );
  const from = folderSessions.findIndex((session) => session.id === draggedId);
  const to = folderSessions.findIndex((session) => session.id === targetId);
  if (from === -1 || to === -1) return null;
  const reordered = [...folderSessions];
  reordered.splice(from, 1);
  // After removal, index `to` lands the dragged row before the target when
  // dragging up and after it when dragging down — the usual drop semantics.
  reordered.splice(to, 0, dragged);
  const queue = [...reordered];
  const result: string[] = [];
  for (const session of active) {
    result.push(
      sessionGroupFolder(session) === targetKey
        ? queue.shift()!.id
        : session.id,
    );
  }
  return result;
}

/** Distinct folders from sessions, in first-seen session order. */
export function recentFolders(
  sessions: readonly AgentSessionSummary[],
): readonly string[] {
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const session of sessions) {
    const key = sessionGroupFolder(session);
    if (key && !seen.has(key)) {
      seen.add(key);
      folders.push(key);
    }
  }
  return folders;
}

/**
 * Distinct folders from sessions, ordered by each folder's most recent
 * session (newest first). Folders never seen sort last, keeping first-seen
 * order among themselves.
 */
export function foldersByRecentUse(
  sessions: readonly AgentSessionSummary[],
): readonly string[] {
  const latest = new Map<string, number>();
  const firstSeen: string[] = [];
  for (const session of sessions) {
    const key = sessionGroupFolder(session);
    if (!key) continue;
    if (!latest.has(key)) firstSeen.push(key);
    const time = session.updatedAt.getTime();
    const current = latest.get(key);
    if (current === undefined || time > current) latest.set(key, time);
  }
  return [...firstSeen].sort(
    (a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0),
  );
}

/**
 * Apply a saved manual order to the recent folders: saved folders keep their
 * order, folders not in the saved order (new ones) append at the end.
 */
export function orderedFolders(
  recent: readonly string[],
  savedOrder: readonly string[] | null,
): readonly string[] {
  if (!savedOrder || savedOrder.length === 0) return recent;
  const known = new Set(recent);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const folder of savedOrder) {
    if (known.has(folder) && !seen.has(folder)) {
      seen.add(folder);
      ordered.push(folder);
    }
  }
  for (const folder of recent) {
    if (!seen.has(folder)) {
      seen.add(folder);
      ordered.push(folder);
    }
  }
  return ordered;
}

export function folderName(folder: string): string {
  const trimmed = folder.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** The parent path of a folder path, or "" when there is no parent. */
export function folderPathPrefix(folder: string): string {
  const trimmed = folder.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? "" : trimmed.slice(0, index);
}

/**
 * Names that appear more than once in a list of folder paths, so their
 * entries need a path prefix to stay distinguishable.
 */
export function duplicateFolderNames(folders: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const folder of folders) {
    const name = folderName(folder);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [name, count] of counts) {
    if (count > 1) duplicates.add(name);
  }
  return duplicates;
}

/** Shorten a path from the left, keeping its distinguishing tail. */
export function truncatePathStart(path: string, max = 34): string {
  if (path.length <= max) return path;
  return "…" + path.slice(path.length - (max - 1));
}

const sameDate = (a: Date | null, b: Date | null): boolean =>
  a === b || (a !== null && b !== null && a.getTime() === b.getTime());

const samePlan = (a: AgentPlan | null, b: AgentPlan | null): boolean => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.tasks.length === b.tasks.length &&
    a.tasks.every(
      (task, i) =>
        task.done === b.tasks[i].done && task.text === b.tasks[i].text,
    )
  );
};

const sameSession = (a: AgentSessionSummary, b: AgentSessionSummary): boolean =>
  a.id === b.id &&
  a.title === b.title &&
  a.folder === b.folder &&
  a.originFolder === b.originFolder &&
  a.providerId === b.providerId &&
  a.modelId === b.modelId &&
  a.reasoningEffort === b.reasoningEffort &&
  a.mode === b.mode &&
  a.status === b.status &&
  a.statusDetail === b.statusDetail &&
  a.seenStatusDetail === b.seenStatusDetail &&
  a.lastError === b.lastError &&
  samePlan(a.plan, b.plan) &&
  sameDate(a.archivedAt, b.archivedAt) &&
  sameDate(a.createdAt, b.createdAt) &&
  sameDate(a.updatedAt, b.updatedAt);

/**
 * Field-wise equality for session summary lists. The host pushes fresh
 * objects on every tick, so reference equality always fails; this lets the
 * renderer skip no-op updates that would otherwise tear the sidebar down
 * mid-interaction.
 */
export function sessionsShallowEqual(
  a: readonly AgentSessionSummary[],
  b: readonly AgentSessionSummary[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((session, i) => sameSession(session, b[i]));
}
