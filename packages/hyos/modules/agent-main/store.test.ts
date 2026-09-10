import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import type { AgentSessionTabs } from "../../capabilities/agent.js";
import { hydb, memoryStorage } from "@hyos/hydb";

import { agentSchema, agentSessions } from "./model.js";
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

test("renameSession updates the title and publishes the change", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const turn = await store.createSession({
      prompt: "Investigate the failing test",
      folder: "/tmp/project",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });
    const session = await store.getSession(turn.sessionId);
    assert.equal(session.title, "Investigate the failing test");

    let observedChange = false;
    const changed = new Promise<void>((resolve) => {
      let unsubscribe: () => void = () => undefined;
      unsubscribe = store.watchSessions(() => {
        if (!observedChange) return;
        unsubscribe();
        resolve();
      });
    });

    observedChange = true;
    await store.renameSession(turn.sessionId, "Fix flaky gateway test");
    await changed;

    const renamed = await store.getSession(turn.sessionId);
    assert.equal(renamed.title, "Fix flaky gateway test");
    const sessions = await store.listSessions();
    assert.equal(sessions[0].title, "Fix flaky gateway test");
  } finally {
    await database.close();
  }
});

test("renameSession trims and clamps long or multi-line titles", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const turn = await store.createSession({
      prompt: "Prompt",
      folder: "/tmp/project",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });
    await store.renameSession(
      turn.sessionId,
      "  Generated title line\n  second line ignored  ",
    );
    const session = await store.getSession(turn.sessionId);
    assert.equal(session.title, "Generated title line");

    const long = "x".repeat(120);
    await store.renameSession(turn.sessionId, long);
    const clamped = await store.getSession(turn.sessionId);
    // titleFromPrompt keeps 69 characters plus the ellipsis.
    assert.equal(clamped.title.length, 70);
    assert.ok(clamped.title.startsWith("x".repeat(69)));
    assert.ok(clamped.title.endsWith("…"));
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

test("a follow-up turn atomically persists a reasoning-effort change", async () => {
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
    assert.equal(
      (await store.getSession(turn.sessionId)).reasoningEffort,
      "medium",
    );

    await store.startTurn(turn.sessionId, "Go deeper", undefined, "high");

    const session = await store.getSession(turn.sessionId);
    assert.equal(session.reasoningEffort, "high");
    assert.equal(session.modelId, "zai/glm-5.3-flash");
    assert.equal(session.mode, "standard");
  } finally {
    await database.close();
  }
});

test("finishRun persists token usage on the assistant message", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const turn = await store.createSession({
      prompt: "Measure the context",
      folder: "/tmp/project",
      providerId: "glm",
      modelId: "zai/glm-5.3-flash",
    });
    await store.finishRun(turn.sessionId, turn.assistantMessageId, null, {
      promptTokens: 42_300,
      completionTokens: 128,
      contextWindow: 800_000,
    });

    const page = await store.pageMessages(turn.sessionId, null, 10);
    const assistant = page.messages.find(
      (message) => message.id === turn.assistantMessageId,
    );
    assert.ok(assistant);
    assert.deepEqual(assistant.usage, {
      promptTokens: 42_300,
      completionTokens: 128,
      contextWindow: 800_000,
    });
  } finally {
    await database.close();
  }
});

test("session plans persist on the summary and round-trip", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const turn = await store.createSession({
      prompt: "Plan the work",
      folder: "/tmp/project",
      providerId: "glm",
      modelId: "zai/glm-5.3-flash",
      mode: "incremental",
    });
    assert.equal((await store.getSession(turn.sessionId)).plan, null);

    const plan = {
      tasks: [
        { text: "Plan format + prompt policy", done: true },
        { text: "Plan parser", done: false },
      ],
    };
    await store.updatePlan(turn.sessionId, plan);

    const session = await store.getSession(turn.sessionId);
    assert.deepEqual(session.plan, plan);
    const sessions = await store.listSessions();
    assert.deepEqual(sessions[0].plan, plan);

    await store.updatePlan(turn.sessionId, null);
    assert.equal((await store.getSession(turn.sessionId)).plan, null);
  } finally {
    await database.close();
  }
});

test("session tabs persist on the session row and decode defensively", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const turn = await store.createSession({
      prompt: "Open some tabs",
      folder: "/tmp/project",
      providerId: "glm",
      modelId: "zai/glm-5.3-flash",
    });
    assert.equal(await store.loadSessionTabs(turn.sessionId), null);

    const tabs: AgentSessionTabs = {
      tabs: [
        { kind: "browser", url: "https://example.com/", title: "Example" },
        {
          kind: "browser",
          url: "https://news.ycombinator.com/",
          title: "Hacker News",
        },
      ],
      activeIndex: 1,
    };
    await store.saveSessionTabs(turn.sessionId, tabs);
    assert.deepEqual(await store.loadSessionTabs(turn.sessionId), tabs);

    // Tab bookkeeping is background pane state: saving must not bump
    // updatedAt, which would reorder the sessions list.
    const updatedAt = (await store.listSessions())[0].updatedAt;
    await store.saveSessionTabs(turn.sessionId, tabs);
    assert.equal(
      (await store.listSessions())[0].updatedAt.getTime(),
      updatedAt.getTime(),
    );

    await store.saveSessionTabs(turn.sessionId, null);
    assert.equal(await store.loadSessionTabs(turn.sessionId), null);

    // Garbage in the column — torn or hand-edited — reads as "no tabs".
    const writeRawTabs = hydb.command({
      input: z.object({ sessionId: z.string(), tabs: z.string().nullable() }),
      async handler(transaction, input) {
        await transaction.update(agentSessions, [input.sessionId], {
          tabs: input.tabs,
        });
      },
    });
    const writeRaw = async (raw: string): Promise<void> => {
      await database.execute(writeRawTabs, {
        sessionId: turn.sessionId,
        tabs: raw,
      });
    };
    await writeRaw("not-json");
    assert.equal(await store.loadSessionTabs(turn.sessionId), null);
    await writeRaw('{"version":99,"tabs":[],"activeIndex":0}');
    assert.equal(await store.loadSessionTabs(turn.sessionId), null);
    // Unknown tab kinds belong to newer builds and are dropped; the broken
    // entry goes too, and the focused index clamps into the survivors.
    await writeRaw(
      JSON.stringify({
        version: 1,
        tabs: [
          { kind: "browser", url: "https://example.com/", title: "Example" },
          { kind: "terminal", cwd: "/tmp/project" },
          { kind: "browser", url: "", title: "Broken" },
        ],
        activeIndex: 2,
      }),
    );
    assert.deepEqual(await store.loadSessionTabs(turn.sessionId), {
      tabs: [
        { kind: "browser", url: "https://example.com/", title: "Example" },
      ],
      activeIndex: 0,
    });
    // -1 is meaningful: no browser tab was focused (the pinned tab was).
    await writeRaw(
      JSON.stringify({
        version: 1,
        tabs: [
          { kind: "browser", url: "https://example.com/", title: "Example" },
        ],
        activeIndex: -1,
      }),
    );
    assert.deepEqual(await store.loadSessionTabs(turn.sessionId), {
      tabs: [
        { kind: "browser", url: "https://example.com/", title: "Example" },
      ],
      activeIndex: -1,
    });
  } finally {
    await database.close();
  }
});

test("watchSessionTabs fires with decoded strips as they are saved", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const first = await store.createSession({
      prompt: "First",
      folder: "/tmp/project",
      providerId: "glm",
      modelId: "zai/glm-5.3-flash",
    });
    const second = await store.createSession({
      prompt: "Second",
      folder: "/tmp/project",
      providerId: "glm",
      modelId: "zai/glm-5.3-flash",
    });

    const changes: import("../../capabilities/agent.js").AgentSessionTabsChange[] =
      [];
    let seenChange = false;
    const pending: (() => void)[] = [];
    const unsubscribe = store.watchSessionTabs((change) => {
      changes.push(change);
      if (seenChange) pending.shift()?.();
    });
    const nextChange = (): Promise<void> => {
      seenChange = true;
      return new Promise((resolve) => pending.push(resolve));
    };

    // The subscription seeds before the first save lands; an initial empty
    // snapshot must never fire for a session with no tabs.
    const saved = nextChange();
    const tabs: AgentSessionTabs = {
      tabs: [{ kind: "browser", url: "https://example.com/", title: "Ex" }],
      activeIndex: 0,
    };
    await store.saveSessionTabs(first.sessionId, tabs);
    await saved;
    assert.deepEqual(changes, [{ sessionId: first.sessionId, tabs }]);

    // An unchanged write (identical strip) must not fire — the renderer
    // reconciles against these events and churn would defeat that.
    await store.saveSessionTabs(first.sessionId, tabs);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(changes.length, 1);

    // A different session's strip arrives tagged with its own id. Clearing
    // only fires when a strip actually existed: null over null is no change.
    const secondTabs: AgentSessionTabs = {
      tabs: [
        { kind: "browser", url: "https://news.ycombinator.com/", title: "HN" },
      ],
      activeIndex: 0,
    };
    const secondSaved = nextChange();
    await store.saveSessionTabs(second.sessionId, secondTabs);
    await secondSaved;
    assert.deepEqual(changes[1], {
      sessionId: second.sessionId,
      tabs: secondTabs,
    });

    const cleared = nextChange();
    await store.saveSessionTabs(second.sessionId, null);
    await cleared;
    assert.deepEqual(changes[2], { sessionId: second.sessionId, tabs: null });

    unsubscribe();
  } finally {
    await database.close();
  }
});

test("reorderSessions persists manual order; unordered sessions stay newest-first on top", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);

  try {
    const first = await store.createSession({
      prompt: "First session",
      folder: "/tmp/project",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });
    const second = await store.createSession({
      prompt: "Second session",
      folder: "/tmp/project",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });
    const third = await store.createSession({
      prompt: "Third session",
      folder: "/tmp/project",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });

    // Default: newest first.
    const titles = (sessions: Awaited<ReturnType<typeof store.listSessions>>) =>
      sessions.map(({ title }) => title);
    assert.deepEqual(titles(await store.listSessions()), [
      "Third session",
      "Second session",
      "First session",
    ]);

    // Manual order: move the oldest to the front; the never-ranked middle
    // session stays on top, ahead of everything with a rank.
    await store.reorderSessions([first.sessionId, third.sessionId]);
    const ordered = await store.listSessions();
    assert.deepEqual(titles(ordered), [
      "Second session",
      "First session",
      "Third session",
    ]);

    // A session created after a reorder has no rank yet: it lands on top.
    const fourth = await store.createSession({
      prompt: "Fourth session",
      folder: "/tmp/project",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });
    assert.deepEqual(titles(await store.listSessions()), [
      "Fourth session",
      "Second session",
      "First session",
      "Third session",
    ]);

    // Re-ranking everything (the client always sends the full list) rewrites ranks.
    await store.reorderSessions([
      fourth.sessionId,
      second.sessionId,
      first.sessionId,
      third.sessionId,
    ]);
    assert.deepEqual(titles(await store.listSessions()), [
      "Fourth session",
      "Second session",
      "First session",
      "Third session",
    ]);
  } finally {
    await database.close();
  }
});
