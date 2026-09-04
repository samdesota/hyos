import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentMessage,
  AgentSessionSummary,
} from "../../capabilities/agent.js";
import {
  collapseWorkRuns,
  folderName,
  partitionSessions,
  recentFolders,
  timelineEntries,
  workPaneLabel,
} from "./AgentApp.js";
import { resizedPatchPanelWidth } from "./patch-panel.js";
import { hashForSession, sessionFromHash } from "./session-route.js";
import { agentStyles } from "./styles.js";

function sessionSummary(
  id: string,
  archivedAt: Date | null,
): AgentSessionSummary {
  const now = new Date("2026-09-04T00:00:00.000Z");
  return {
    id,
    title: id,
    folder: "/tmp/project",
    providerId: "codex",
    modelId: "gpt-5.6-sol",
    reasoningEffort: null,
    mode: "standard",
    status: "ready",
    lastError: null,
    archivedAt,
    createdAt: now,
    updatedAt: now,
  };
}

test("sessions are partitioned into active and archived lists", () => {
  const sessions = [
    sessionSummary("live-1", null),
    sessionSummary("archived-1", new Date("2026-09-03T10:00:00.000Z")),
    sessionSummary("live-2", null),
  ];

  assert.deepEqual(partitionSessions(sessions), {
    active: [sessions[0], sessions[2]],
    archived: [sessions[1]],
  });
});

test("recent folders are deduplicated in session order", () => {
  const folder = (path: string): AgentSessionSummary => ({
    ...sessionSummary("session", null),
    folder: path,
  });

  assert.deepEqual(recentFolders([]), []);
  assert.deepEqual(
    recentFolders([
      folder("/tmp/alpha"),
      folder("/tmp/beta"),
      folder("/tmp/alpha"),
      folder("/tmp/gamma"),
    ]),
    ["/tmp/alpha", "/tmp/beta", "/tmp/gamma"],
  );
});

test("folderName extracts the basename of a folder path", () => {
  assert.equal(folderName("/Users/sam/projects/hyos"), "hyos");
  assert.equal(folderName("/Users/sam/projects/hyos/"), "hyos");
  assert.equal(folderName("hyos"), "hyos");
});

test("terminal assistant failures remain visible without response text", () => {
  const now = new Date();
  const failed: AgentMessage = {
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    status: "failed",
    content: "",
    activity: null,
    lastError: "Patch explanation was missing.",
    usage: null,
    createdAt: now,
    updatedAt: now,
  };

  assert.deepEqual(timelineEntries([failed]), [
    { type: "message", message: failed },
  ]);
});

test("live message arrival order cannot place thinking after the final response", () => {
  const thinking: AgentMessage = {
    id: "thinking-1",
    sessionId: "session-1",
    role: "assistant",
    status: "complete",
    content: "Inspecting the implementation",
    activity: { type: "commentary", text: "Inspecting the implementation" },
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:00.000Z"),
    updatedAt: new Date("2026-09-03T12:00:01.000Z"),
  };
  const finalResponse: AgentMessage = {
    id: "final-1",
    sessionId: "session-1",
    role: "assistant",
    status: "complete",
    content: "Implemented the requested change.",
    activity: null,
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:02.000Z"),
    updatedAt: new Date("2026-09-03T12:00:02.000Z"),
  };

  assert.deepEqual(timelineEntries([finalResponse, thinking]), [
    { type: "message", message: thinking },
    { type: "message", message: finalResponse },
  ]);
});

test("finished runs collapse thinking into a work pane before the final response", () => {
  const thinking: AgentMessage = {
    id: "thinking-1",
    sessionId: "session-1",
    role: "assistant",
    status: "complete",
    content: "Inspecting the implementation",
    activity: { type: "commentary", text: "Inspecting the implementation" },
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:00.000Z"),
    updatedAt: new Date("2026-09-03T12:00:01.000Z"),
  };
  const finalResponse: AgentMessage = {
    id: "final-1",
    sessionId: "session-1",
    role: "assistant",
    status: "complete",
    content: "Implemented the requested change.",
    activity: null,
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:32.000Z"),
    updatedAt: new Date("2026-09-03T12:00:32.000Z"),
  };
  const timeline = collapseWorkRuns(timelineEntries([thinking, finalResponse]));

  assert.deepEqual(timeline, [
    {
      type: "work",
      entries: [{ type: "message", message: thinking }],
      startedAt: thinking.createdAt,
      endedAt: finalResponse.createdAt,
    },
    { type: "message", message: finalResponse },
  ]);
  assert.equal(
    workPaneLabel(thinking.createdAt, finalResponse.createdAt),
    "Worked for 32s",
  );
});

test("streaming thinking stays inline until the run completes", () => {
  const thinking: AgentMessage = {
    id: "thinking-1",
    sessionId: "session-1",
    role: "assistant",
    status: "streaming",
    content: "Inspecting the implementation",
    activity: { type: "commentary", text: "Inspecting the implementation" },
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:00.000Z"),
    updatedAt: new Date("2026-09-03T12:00:01.000Z"),
  };
  const finalResponse: AgentMessage = {
    id: "final-1",
    sessionId: "session-1",
    role: "assistant",
    status: "streaming",
    content: "",
    activity: null,
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:32.000Z"),
    updatedAt: new Date("2026-09-03T12:00:32.000Z"),
  };
  const timeline = collapseWorkRuns(timelineEntries([thinking, finalResponse]));

  assert.deepEqual(timeline, [
    { type: "message", message: thinking },
    { type: "message", message: finalResponse },
  ]);
});

test("session routes round-trip through the URL hash", () => {
  assert.equal(hashForSession(null), "");
  assert.equal(hashForSession("session-1"), "#/session/session-1");
  assert.equal(sessionFromHash("#/session/session-1"), "session-1");
  assert.equal(sessionFromHash("#/session/ses%2Fsion"), "ses/sion");
  assert.equal(sessionFromHash("#/other"), null);
  assert.equal(sessionFromHash(""), null);
});

test("locked diffs let wheel scrolling reach the patch list", () => {
  const lockedRule = agentStyles.match(/^\s*\.diff-body\s*\{[^}]*\}/m)?.[0];
  assert.ok(lockedRule);
  assert.match(lockedRule, /overflow-y:\s*hidden/);
  assert.doesNotMatch(lockedRule, /overscroll-behavior:\s*contain/);
});

test("patch resizing uses the conversation width instead of the panel width", () => {
  const conversation = { clientWidth: 1_100 };
  const divider = {
    closest(selector: string) {
      return selector === ".conversation" ? conversation : null;
    },
  };

  assert.equal(
    resizedPatchPanelWidth({
      divider,
      fallbackWidth: 1_100,
      startWidth: 520,
      startX: 600,
      currentX: 500,
    }),
    620,
  );
});
