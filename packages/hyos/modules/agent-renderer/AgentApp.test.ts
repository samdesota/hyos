import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "../../capabilities/agent.js";
import { timelineEntries } from "./AgentApp.js";
import { resizedPatchPanelWidth } from "./patch-panel.js";
import { agentStyles } from "./styles.js";

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
    createdAt: new Date("2026-09-03T12:00:02.000Z"),
    updatedAt: new Date("2026-09-03T12:00:02.000Z"),
  };

  assert.deepEqual(timelineEntries([finalResponse, thinking]), [
    { type: "message", message: thinking },
    { type: "message", message: finalResponse },
  ]);
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
