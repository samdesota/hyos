import assert from "node:assert/strict";
import test from "node:test";

import { hydb, memoryStorage } from "@hyos/hydb";

import {
  createAgentHost,
  promptWithPersistedContext,
  toolDetailKeepSet,
  turnTranscript,
} from "./host.js";
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
    browser: {
      id: "browser",
      version: 2,
      call: async () => ({
        generation: 0,
        sequence: 0,
        activeTabId: null,
        tabs: [],
      }),
      subscribe: () => () => {},
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
      browser: {
        id: "browser",
        version: 2,
        call: async () => ({
          generation: 0,
          sequence: 0,
          activeTabId: null,
          tabs: [],
        }),
        subscribe: () => () => {},
      } as never,
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
    usage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const slim = promptWithPersistedContext("resume", [
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

  assert.match(slim, /user: Build the differential dataflow engine/);
  assert.doesNotMatch(slim, /Add canonical row keys/);
  assert.match(slim, /<turn id="turn-1">/);
  assert.match(slim, /<current-user-message>\nresume/);

  const history = [
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
    message({ role: "assistant", content: "Done — keys are canonical." }),
  ];

  const full = turnTranscript(
    [...history, message({ content: "resume" })],
    "turn-1",
  );
  assert.match(full!, /agent patch: Add canonical row keys/);
  assert.match(full!, /\+export function canonicalKey\(\) \{\}/);
  assert.match(full!, /assistant: Done — keys are canonical\./);

  // Malformed, unknown, or current-turn ids resolve to null.
  assert.equal(turnTranscript(history, "no-such-turn"), null);
  assert.equal(turnTranscript(history, "turn-2"), null);
  assert.equal(
    turnTranscript([...history, message({ content: "resume" })], "turn-1 "),
    null,
  );
});

test("the slim transcript keeps thinking and recent tool responses intact", () => {
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
    usage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const toolDetail = `${"a".repeat(300)}${"b".repeat(200)}`;
  const slim = promptWithPersistedContext("next", [
    message({ content: "Add the diff engine" }),
    message({
      role: "system",
      activity: { type: "commentary", text: "Reading the executor first" },
    }),
    message({
      role: "system",
      activity: {
        type: "tool",
        category: "read",
        label: "Read files",
        detail: toolDetail,
      },
    }),
    message({ role: "assistant", content: "Engine skeleton is in place." }),
    message({ content: "next" }),
  ]);

  assert.match(slim, /user: Add the diff engine/);
  assert.match(slim, /agent reasoning: Reading the executor first/);
  // Recent tool results stay intact — no short-hint truncation.
  assert.ok(
    slim.includes(`agent tool (Read files): ${toolDetail}`),
    "keeps recent tool responses intact",
  );
  assert.match(slim, /assistant: Engine skeleton is in place\./);
  assert.match(slim, /<turn id="turn-1">/);
  assert.match(slim, /<current-user-message>\nnext/);
});

test("the tool window keeps the most recent results within budget, at least 3", () => {
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
    usage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const tool = () =>
    message({
      role: "system",
      activity: {
        type: "tool",
        category: "read",
        label: "Read files",
        detail: "x".repeat(40),
      },
    });

  // Budget 100 chars: the three most recent fit (floor), the oldest does not.
  const outside = tool();
  const kept = [tool(), tool(), tool()];
  const history = [
    message({ content: "one" }),
    outside,
    message({ content: "two" }),
    ...kept,
    message({ content: "next" }),
  ];
  const keep = toolDetailKeepSet(history, history.length - 1, 100, 3);
  assert.deepEqual([...keep].sort(), kept.map((m) => m.id).sort());

  // The floor holds even when the recent results blow the budget entirely.
  const flooredHistory = [
    message({ content: "one" }),
    outside,
    ...kept,
    message({ content: "next" }),
  ];
  const floored = toolDetailKeepSet(
    flooredHistory,
    flooredHistory.length - 1,
    0,
    3,
  );
  assert.deepEqual([...floored].sort(), kept.map((m) => m.id).sort());
});

test("the slim transcript clears tool detail outside the recent window", () => {
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
    usage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const tool = (label: string, mark: string) =>
    message({
      role: "system",
      activity: {
        type: "tool",
        category: "read",
        label,
        // 60k chars ≈ 15k tokens each: three fill the ~40k-token window.
        detail: mark.repeat(60_000),
      },
    });
  const slim = promptWithPersistedContext("next", [
    message({ content: "Request 1" }),
    tool("Logs one", "1"),
    message({ role: "assistant", content: "Response 1" }),
    message({ content: "Request 2" }),
    tool("Logs two", "2"),
    message({ role: "assistant", content: "Response 2" }),
    message({ content: "Request 3" }),
    tool("Logs three", "3"),
    message({ role: "assistant", content: "Response 3" }),
    message({ content: "Request 4" }),
    tool("Logs four", "4"),
    message({ role: "assistant", content: "Response 4" }),
    message({ content: "next" }),
  ]);

  // The oldest result falls outside the ~40k-token window: stubbed, not kept.
  assert.match(slim, /agent tool \(Logs one\): \[older tool result cleared\]/);
  assert.ok(!slim.includes("1".repeat(500)), "oldest tool detail is gone");
  // The most recent result stays intact.
  assert.ok(slim.includes("4".repeat(500)), "recent tool detail survives");
});

test("the slim transcript drops thinking for turns older than the last 5", () => {
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
    usage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  // Six prior turns: exactly the oldest falls outside the last-5 window.
  const turns = Array.from({ length: 6 }, (_, turn) => [
    message({ content: `Request ${turn + 1}` }),
    message({
      role: "system",
      activity: {
        type: "commentary",
        text: `Reasoning for turn ${turn + 1}`,
      },
    }),
    message({ role: "assistant", content: `Response ${turn + 1}` }),
  ]).flat();
  const slim = promptWithPersistedContext("next", [
    ...turns,
    message({ content: "next" }),
  ]);

  assert.match(slim, /last 5 turns/);
  assert.doesNotMatch(slim, /Reasoning for turn 1\b/);
  for (let turn = 2; turn <= 6; turn += 1) {
    assert.match(slim, new RegExp(`Reasoning for turn ${turn}`));
  }
  // The old turn itself stays — only its thinking is dropped.
  assert.match(slim, /user: Request 1/);
  assert.match(slim, /assistant: Response 1/);
});

async function waitFor<T>(
  probe: () => Promise<T> | T,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a finished incremental turn persists its plan and replays it on the next turn", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);
  const inputs: import("./providers/types.js").AgentRunInput[] = [];
  const planBlock = [
    "```hyos-plan",
    "- [x] Plan format + prompt policy",
    "- [ ] Plan parser",
    "```",
  ].join("\n");
  const plan = {
    tasks: [
      { text: "Plan format + prompt policy", done: true },
      { text: "Plan parser", done: false },
    ],
  };
  let firstResponse!: () => void;
  const firstResponseSent = new Promise<void>((resolve) => {
    firstResponse = resolve;
  });
  let secondRun!: () => void;
  const secondRunStarted = new Promise<void>((resolve) => {
    secondRun = resolve;
  });
  const provider: AgentProvider = {
    summary: {
      id: "test",
      label: "Test",
      models: [{ id: "test-model", label: "Test model" }],
    },
    async run(input, sink) {
      inputs.push(input);
      if (inputs.length === 1) {
        await sink.response(`Plan is ready.\n\n${planBlock}`);
        firstResponse();
        return { providerSessionId: null };
      }
      secondRun();
      return { providerSessionId: null };
    },
  };
  const host = createAgentHost({
    window: {} as never,
    remote: { publish() {} } as never,
    browser: {
      id: "browser",
      version: 2,
      call: async () => ({
        generation: 0,
        sequence: 0,
        activeTabId: null,
        tabs: [],
      }),
      subscribe: () => () => {},
    } as never,
    store,
    providers: new Map([[provider.summary.id, provider]]),
  });

  try {
    await host.start();
    const created = await host.provider.execute({
      type: "start-session",
      prompt: "Build the plan feature",
      folder: "/tmp",
      providerId: "test",
      modelId: "test-model",
      mode: "incremental",
    });
    assert.equal(created.type, "session-started");
    if (created.type !== "session-started") return;
    await firstResponseSent;
    const persisted = await waitFor(
      async () => (await store.getSession(created.sessionId)).plan,
      "the persisted plan",
    );
    assert.deepEqual(persisted, plan);
    assert.equal(inputs[0].plan, null);

    // A final response without a plan block leaves the plan of record alone.
    await host.provider.execute({
      type: "send-message",
      sessionId: created.sessionId,
      prompt: "continue",
    });
    await secondRunStarted;
    await waitFor(
      async () =>
        (await store.pageMessages(created.sessionId, null, 10)).messages.every(
          (message) => message.status !== "streaming",
        )
          ? true
          : null,
      "the second turn to finish",
    );
    assert.deepEqual((await store.getSession(created.sessionId)).plan, plan);
    assert.deepEqual(inputs[1].plan, plan);
    assert.equal(inputs[1].mode, "incremental");
  } finally {
    await host.dispose();
    await database.close();
  }
});

test("session tabs round-trip through the agent provider", async () => {
  const storage = await memoryStorage({ schema: agentSchema });
  const database = await hydb.database({ schema: agentSchema, storage });
  const store = createAgentStore(database);
  const host = createAgentHost({
    window: {} as never,
    remote: { publish: () => {} } as never,
    browser: {
      id: "browser",
      version: 2,
      call: async () => ({
        generation: 0,
        sequence: 0,
        activeTabId: null,
        tabs: [],
      }),
      subscribe: () => () => {},
    } as never,
    store,
    providers: new Map(),
  });

  try {
    await host.start();
    const turn = await store.createSession({
      prompt: "Open some tabs",
      folder: "/tmp/project",
      providerId: "test",
      modelId: "test-model",
    });
    assert.equal(await host.provider.sessionTabs(turn.sessionId), null);

    const tabs: import("../../capabilities/agent.js").AgentSessionTabs = {
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
    await host.provider.saveSessionTabs(turn.sessionId, tabs);
    assert.deepEqual(await host.provider.sessionTabs(turn.sessionId), tabs);

    // Clearing drops the persisted tabs.
    await host.provider.saveSessionTabs(turn.sessionId, null);
    assert.equal(await host.provider.sessionTabs(turn.sessionId), null);
  } finally {
    await host.dispose();
    await database.close();
  }
});
