import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "../../capabilities/agent.js";
import { patchEntries } from "./AgentApp.js";
import { createAutoScrollController } from "./auto-scroll.js";

test("content growth keeps following until the user scrolls over 100px away", () => {
  const controller = createAutoScrollController(100);

  assert.equal(
    controller.shouldFollow({
      scrollHeight: 1_000,
      scrollTop: 800,
      clientHeight: 200,
    }),
    true,
  );
  assert.equal(
    controller.shouldFollow({
      scrollHeight: 1_180,
      scrollTop: 800,
      clientHeight: 200,
    }),
    true,
  );

  controller.observeScroll({
    scrollHeight: 1_180,
    scrollTop: 820,
    clientHeight: 200,
  });
  assert.equal(
    controller.shouldFollow({
      scrollHeight: 1_300,
      scrollTop: 820,
      clientHeight: 200,
    }),
    false,
  );

  controller.observeScroll({
    scrollHeight: 1_300,
    scrollTop: 1_020,
    clientHeight: 200,
  });
  assert.equal(
    controller.shouldFollow({
      scrollHeight: 1_360,
      scrollTop: 1_020,
      clientHeight: 200,
    }),
    true,
  );
});

test("patches render from earliest to latest", () => {
  const patch = (id: string, createdAt: string): AgentMessage => ({
    id,
    sessionId: "session-1",
    role: "system",
    status: "complete",
    content: id,
    activity: {
      type: "patch",
      explanation: id,
      changes: [],
      diff: "",
    },
    lastError: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  });
  const earlier = patch("earlier", "2026-09-03T12:00:00.000Z");
  const later = patch("later", "2026-09-03T12:00:01.000Z");

  assert.deepEqual(patchEntries([earlier, later]), [earlier, later]);
});
