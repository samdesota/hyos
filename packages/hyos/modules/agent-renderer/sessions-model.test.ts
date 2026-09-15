import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionSummary } from "../../capabilities/agent.js";
import {
  groupSessionsByFolder,
  recentFolders,
  reorderWithinFolder,
  sessionsShallowEqual,
} from "./sessions-model.js";

const summary = (
  overrides: Partial<AgentSessionSummary> = {},
): AgentSessionSummary => ({
  id: "s1",
  title: "Session",
  folder: "/tmp/project",
  originFolder: null,
  providerId: "glm",
  modelId: "glm-4",
  reasoningEffort: null,
  mode: "incremental",
  plan: null,
  status: "ready",
  statusDetail: null,
  seenStatusDetail: null,
  lastError: null,
  archivedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

test("equal lists compare by value, not reference", () => {
  const base = [summary()];
  const copy = [summary({ updatedAt: new Date(0) })];
  assert.equal(sessionsShallowEqual(base, copy), true);
  assert.equal(sessionsShallowEqual(base, base), true);
  assert.equal(sessionsShallowEqual([], []), true);
});

test("any meaningful field change is detected", () => {
  const base = [summary()];
  const changes: Partial<AgentSessionSummary>[] = [
    { status: "running" },
    { statusDetail: "Fixing spinner" },
    { seenStatusDetail: "Fixing spinner" },
    { title: "Renamed" },
    { folder: "/tmp/other" },
    { lastError: "boom" },
    { archivedAt: new Date(1) },
    { updatedAt: new Date(2) },
    { plan: { tasks: [{ text: "a", done: false }] } },
    { plan: { tasks: [{ text: "a", done: true }] } },
  ];
  for (const change of changes) {
    assert.equal(
      sessionsShallowEqual(base, [summary(change)]),
      false,
      JSON.stringify(change),
    );
  }
  assert.equal(sessionsShallowEqual(base, []), false);
  assert.equal(sessionsShallowEqual(base, [summary(), summary()]), false);
});

test("equal plans with fresh task objects compare equal", () => {
  const a = [summary({ plan: { tasks: [{ text: "t", done: true }] } })];
  const b = [summary({ plan: { tasks: [{ text: "t", done: true }] } })];
  assert.equal(sessionsShallowEqual(a, b), true);
});

test("reorderWithinFolder moves a session inside its folder group", () => {
  const sessions = [
    summary({ id: "a" }),
    summary({ id: "b" }),
    summary({ id: "d" }),
    summary({ id: "c", folder: "/tmp/other" }),
  ];
  // The sidebar list is folder-grouped, so /tmp/project sessions are
  // contiguous: a, b, d. Drag "a" onto "d": "a" moves after "d", the other
  // folder keeps its slot.
  assert.deepEqual(reorderWithinFolder(sessions, "a", "d"), [
    "b",
    "d",
    "a",
    "c",
  ]);
  // Drag "d" onto "a": "d" moves before "a".
  assert.deepEqual(reorderWithinFolder(sessions, "d", "a"), [
    "d",
    "a",
    "b",
    "c",
  ]);
});

test("reorderWithinFolder rejects no-op and cross-folder drops", () => {
  const sessions = [
    summary({ id: "a" }),
    summary({ id: "b", folder: "/tmp/x" }),
  ];
  assert.equal(reorderWithinFolder(sessions, "a", "a"), null);
  assert.equal(reorderWithinFolder(sessions, "a", "b"), null);
  assert.equal(reorderWithinFolder(sessions, "a", "missing"), null);
});

test("worktree sessions group under their origin folder", () => {
  const origin = "/Users/sam/projects/hyos";
  const worktree = "/Users/sam/.hyos/worktrees/hyos";
  const sessions = [
    summary({ id: "plain", folder: origin }),
    summary({ id: "wt", folder: worktree, originFolder: origin }),
    summary({ id: "elsewhere", folder: "/tmp/other" }),
  ];
  const groups = groupSessionsByFolder(sessions);
  assert.deepEqual(
    groups.map((group) => ({
      folder: group.folder,
      sessions: group.sessions.map((session) => session.id),
    })),
    [
      // One group for the origin folder, containing both the plain session
      // and the worktree session — no duplicate worktree folder entry.
      { folder: origin, sessions: ["plain", "wt"] },
      { folder: "/tmp/other", sessions: ["elsewhere"] },
    ],
  );
  // The folder dropdown derives from the same grouping key, so the worktree
  // path never appears as a separate recent folder.
  assert.deepEqual(recentFolders(sessions), [origin, "/tmp/other"]);
});

test("reorderWithinFolder groups worktree sessions with their origin", () => {
  const origin = "/tmp/project";
  const sessions = [
    summary({ id: "a" }),
    summary({ id: "wt", folder: "/tmp/wt", originFolder: origin }),
    summary({ id: "c", folder: "/tmp/other" }),
  ];
  // Dragging "a" onto the worktree session reorders them within the shared
  // origin group.
  assert.deepEqual(reorderWithinFolder(sessions, "a", "wt"), ["wt", "a", "c"]);
  // A worktree session and a same-named non-origin folder don't mix.
  assert.equal(reorderWithinFolder(sessions, "wt", "c"), null);
});
