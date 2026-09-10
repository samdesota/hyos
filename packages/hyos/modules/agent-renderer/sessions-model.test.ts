import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionSummary } from "../../capabilities/agent.js";
import { sessionsShallowEqual } from "./sessions-model.js";

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
