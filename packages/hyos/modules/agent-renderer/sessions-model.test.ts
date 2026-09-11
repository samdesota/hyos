import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionSummary } from "../../capabilities/agent.js";
import { reorderWithinFolder, sessionsShallowEqual } from "./sessions-model.js";

const summary = (
  overrides: Partial<AgentSessionSummary> = {},
): AgentSessionSummary => ({
  id: "s1",
  title: "Session",
  folder: "/tmp/project",
  providerId: "glm",
  modelId: "glm-4",
  reasoningEffort: null,
  mode: "incremental",
  plan: null,
  status: "ready",
  statusDetail: null,
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
