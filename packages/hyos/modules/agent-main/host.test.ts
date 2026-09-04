import assert from "node:assert/strict";
import test from "node:test";

import { hydb, memoryStorage } from "@hyos/hydb";

import { createAgentHost, promptWithPersistedContext } from "./host.js";
import { agentSchema } from "./model.js";
import type { AgentProvider } from "./providers/types.js";
import { createAgentStore } from "./store.js";

test("finishing a turn publishes the final message's new timeline position", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);
  let releaseRun!: () => void;
  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const changes: import("../../capabilities/agent.js").AgentMessageChange[] =
    [];
  let finalChangeSeen!: () => void;
  const finalChange = new Promise<void>((resolve) => {
    finalChangeSeen = resolve;
  });
  const provider: AgentProvider = {
    summary: {
      id: "test",
      label: "Test",
      models: [{ id: "test-model", label: "Test model" }],
    },
    async run(_input, sink) {
      await runReleased;
      await sink.activity(
        "thinking-1",
        {
          type: "commentary",
          text: "Inspecting the implementation",
        },
        "complete",
      );
      await sink.response("Implemented the requested change.");
      return { providerSessionId: null };
    },
  };
  const host = createAgentHost({
    window: {} as never,
    remote: {
      publish(_capability: unknown, event: string, payload: unknown) {
        if (event !== "messageChange") return;
        const change = (
          payload as {
            change: import("../../capabilities/agent.js").AgentMessageChange;
          }
        ).change;
        changes.push(change);
        if (
          (change.type === "message-status" && change.status === "complete") ||
          (change.type === "message-replaced" &&
            change.message.content === "Implemented the requested change.")
        ) {
          finalChangeSeen();
        }
      },
    } as never,
    store,
    providers: new Map([[provider.summary.id, provider]]),
  });

  try {
    await host.start();
    const result = await host.provider.execute({
      type: "start-session",
      prompt: "Fix the renderer",
      folder: "/tmp",
      providerId: "test",
      modelId: "test-model",
    });
    assert.equal(result.type, "session-started");
    if (result.type !== "session-started") return;
    await host.provider.openFeed(result.sessionId, 30);
    releaseRun();
    await finalChange;

    assert.ok(
      changes.some(
        (change) =>
          change.type === "message-replaced" &&
          change.message.content === "Implemented the requested change.",
      ),
    );
  } finally {
    await host.dispose();
    await database.close();
  }
});

test("an interrupted run resumes from its streamed provider session checkpoint", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);
  const observedSessionIds: Array<string | null> = [];
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let resumed!: () => void;
  const resumedRun = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  const provider: AgentProvider = {
    summary: {
      id: "test",
      label: "Test",
      models: [{ id: "test-model", label: "Test model" }],
    },
    async run(input, sink, signal) {
      observedSessionIds.push(input.providerSessionId);
      if (observedSessionIds.length === 1) {
        await sink.session("provider-session-1");
        firstStarted();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("interrupted")),
            { once: true },
          );
        });
      }
      resumed();
      return { providerSessionId: "provider-session-1" };
    },
  };
  const createHost = () =>
    createAgentHost({
      window: {} as never,
      remote: { publish() {} } as never,
      store,
      providers: new Map([[provider.summary.id, provider]]),
    });

  try {
    const firstHost = createHost();
    await firstHost.start();
    const created = await firstHost.provider.execute({
      type: "start-session",
      prompt: "Build the engine",
      folder: "/tmp",
      providerId: "test",
      modelId: "test-model",
    });
    assert.equal(created.type, "session-started");
    if (created.type !== "session-started") return;
    await started;
    await firstHost.dispose();

    const secondHost = createHost();
    await secondHost.start();
    await secondHost.provider.execute({
      type: "send-message",
      sessionId: created.sessionId,
      prompt: "resume",
    });
    await resumedRun;
    assert.deepEqual(observedSessionIds, [null, "provider-session-1"]);
    await secondHost.dispose();
  } finally {
    await database.close();
  }
});

test("a terse resume carries the persisted session transcript", () => {
  const now = new Date();
  const message = (
    overrides: Partial<import("../../capabilities/agent.js").AgentMessage>,
  ) => ({
    id: crypto.randomUUID(),
    sessionId: "session-1",
    role: "user" as const,
    status: "complete" as const,
    content: "",
    activity: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const prompt = promptWithPersistedContext("resume", [
    message({ content: "Build the differential dataflow engine" }),
    message({
      role: "system",
      activity: {
        type: "patch",
        explanation: "Add canonical row keys.",
        changes: [{ path: "src/dataflow/keys.ts", kind: "write" }],
        diff: "+export function canonicalKey() {}",
      },
    }),
    message({ content: "resume" }),
  ]);

  assert.match(prompt, /Build the differential dataflow engine/);
  assert.match(prompt, /Add canonical row keys/);
  assert.match(prompt, /<current-user-message>\nresume/);
});
