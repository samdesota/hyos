import assert from "node:assert/strict";
import test from "node:test";
import { hydb, memoryStorage } from "@hyos/hydb";
import { createCommentaryWriter } from "./commentary-writer.js";
import { createAgentStore } from "./store.js";
import { agentSchema, agentMessageChunks } from "./model.js";

test("1000 cumulative updates persist only new text in a handful of batches", async () => {
  const writes: string[] = [];
  const writer = createCommentaryWriter(
    {
      async appendCommentary(_session, _message, _index, text) {
        writes.push(text);
        return "message";
      },
    },
    "session",
  );
  let text = "";
  for (let i = 0; i < 1000; i++) {
    text += "thinking. ";
    await writer.update("reasoning", text, "streaming");
  }
  await writer.close();
  assert.equal(writes.join(""), text);
  assert.equal(
    writes.reduce((size, text) => size + text.length, 0),
    10000,
  );
  assert.ok(writes.length <= 6, `${writes.length} writes`);
});

test("reasoning is visible while streaming and reconstructs replacements and cancelled tails", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);
  const turn = await store.createSession({
    prompt: "test",
    providerId: "glm",
    modelId: "glm",
    folder: "/tmp",
  });
  const writer = createCommentaryWriter(store, turn.sessionId);
  try {
    await writer.update("reasoning", "First", "streaming");
    await writer.flush();
    await writer.update("reasoning", "First addition", "streaming");
    await writer.flush();
    let page = await store.pageMessages(turn.sessionId, null, 20);
    assert.deepEqual(
      page.messages.find((message) => message.activity)?.activity,
      { type: "commentary", text: "First addition" },
    );
    await writer.update("reasoning", "Corrected summary", "streaming");
    await writer.flush();
    await writer.update("reasoning", "Corrected summary tail", "streaming");
    await writer.close("failed");
    // A fresh store uses only persisted chunks, not the writer's in-memory state.
    page = await createAgentStore(database).pageMessages(
      turn.sessionId,
      null,
      20,
    );
    const messages = page.messages.filter((message) => message.activity);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].activity, {
      type: "commentary",
      text: "Corrected summary tail",
    });
    assert.equal(messages[0].status, "failed");
    const chunks = await database.fetch(
      hydb
        .query(agentMessageChunks)
        .where((chunk) => chunk.messageId.eq(messages[0].id))
        .orderBy((chunk) => chunk.index.asc())
        .many(),
    );
    assert.equal(chunks.length, 4);
    assert.ok(chunks[1].content.includes('"text":" addition"'));
    assert.ok(chunks[3].content.includes('"text":" tail"'));
  } finally {
    await writer.close();
    await database.close();
  }
});

test("timer flushes small updates before the run ends and close drains outstanding writes", async () => {
  let observed!: () => void;
  const visible = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const saved: string[] = [];
  const writer = createCommentaryWriter(
    {
      async appendCommentary(_s, _m, _i, text) {
        saved.push(text);
        observed();
        return "id";
      },
    },
    "session",
  );
  await writer.update("reasoning", "live", "streaming");
  await visible;
  assert.equal(saved[0], "live");
  await writer.update("reasoning", "live tail", "streaming");
  await writer.close();
  assert.equal(saved.join(""), "live tail");
});

test("flush failures are reported when the run closes", async () => {
  const writer = createCommentaryWriter(
    {
      async appendCommentary() {
        throw new Error("disk failure");
      },
    },
    "session",
  );
  await writer.update("reasoning", "pending", "streaming");
  await assert.rejects(writer.close(), /disk failure/);
});
