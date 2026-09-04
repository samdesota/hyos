import assert from "node:assert/strict";
import test from "node:test";

import { hydb, memoryStorage } from "@hyos/hydb";

import { agentSchema } from "./model.js";
import { createAgentStore } from "./store.js";

test("agent sessions persist chunked messages and publish HyDB changes", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const turn = await store.createSession({
      prompt: "Build the first pass",
      folder: "/tmp/project",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "medium",
      mode: "incremental",
    });

    let observedChange = false;
    const changed = new Promise<void>((resolve) => {
      let unsubscribe: () => void = () => undefined;
      unsubscribe = store.watchMessages(turn.sessionId, () => {
        if (!observedChange) return;
        unsubscribe();
        resolve();
      });
    });

    observedChange = true;
    const activityId = await store.upsertActivity(
      turn.sessionId,
      null,
      {
        type: "tool",
        category: "read",
        label: "Read files",
        detail: "rg --files",
      },
      "streaming",
    );
    await store.upsertActivity(
      turn.sessionId,
      activityId,
      {
        type: "tool",
        category: "read",
        label: "Read files",
        detail: "rg --files\npackages/hyos/main.js",
      },
      "complete",
    );
    await store.appendAssistantChunk(
      turn.sessionId,
      turn.assistantMessageId,
      0,
      "First ",
    );
    await store.appendAssistantChunk(
      turn.sessionId,
      turn.assistantMessageId,
      1,
      "response",
    );
    await changed;
    await store.finishRun(turn.sessionId, turn.assistantMessageId, "thread-1");

    const sessions = await store.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, "ready");
    assert.equal(sessions[0].reasoningEffort, "medium");
    assert.equal(sessions[0].mode, "incremental");

    const page = await store.pageMessages(turn.sessionId, null, 20);
    assert.equal(page.messages.length, 3);
    assert.equal(page.messages[0].role, "user");
    assert.equal(page.messages[0].content, "Build the first pass");
    assert.equal(page.messages[1].activity?.type, "tool");
    assert.equal(
      page.messages[1].activity?.type === "tool" &&
        page.messages[1].activity.detail,
      "rg --files\npackages/hyos/main.js",
    );
    assert.equal(page.messages[2].role, "assistant");
    assert.equal(page.messages[2].content, "First response");
    assert.equal(page.messages[2].status, "complete");
    assert.equal(page.hasOlder, false);
  } finally {
    await database.close();
  }
});

test("provider session checkpoints survive an interrupted run", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const turn = await store.createSession({
      prompt: "Build the dataflow engine",
      folder: "/tmp/project",
      providerId: "claude",
      modelId: "sonnet",
    });
    await store.checkpointProviderSession(turn.sessionId, "claude-session-1");
    await store.endRun(
      turn.sessionId,
      turn.assistantMessageId,
      "cancelled",
      "failed",
      "Interrupted",
    );

    const recovered = await store.getSession(turn.sessionId);
    assert.equal(recovered.providerSessionId, "claude-session-1");
    assert.equal(recovered.mode, "standard");
  } finally {
    await database.close();
  }
});

test("sessions can be archived and unarchived", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const turn = await store.createSession({
      prompt: "Archive me",
      folder: "/tmp/project",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });
    assert.equal((await store.getSession(turn.sessionId)).archivedAt, null);

    await store.setSessionArchived(turn.sessionId, true);
    const archived = await store.getSession(turn.sessionId);
    assert.ok(archived.archivedAt instanceof Date);

    await store.setSessionArchived(turn.sessionId, false);
    assert.equal((await store.getSession(turn.sessionId)).archivedAt, null);

    const sessions = await store.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].archivedAt, null);
  } finally {
    await database.close();
  }
});

test("a follow-up turn atomically persists a mode change", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const turn = await store.createSession({
      prompt: "Plan the work",
      folder: "/tmp/project",
      providerId: "glm",
      modelId: "zai/glm-5.3-flash",
      reasoningEffort: "medium",
    });
    assert.equal((await store.getSession(turn.sessionId)).mode, "standard");

    await store.startTurn(
      turn.sessionId,
      "Start the first step",
      "incremental",
    );

    const session = await store.getSession(turn.sessionId);
    assert.equal(session.mode, "incremental");
    assert.equal(session.modelId, "zai/glm-5.3-flash");
    assert.equal(session.reasoningEffort, "medium");
  } finally {
    await database.close();
  }
});
