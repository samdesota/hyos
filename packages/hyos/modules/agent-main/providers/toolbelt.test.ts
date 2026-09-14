import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserState } from "../../../capabilities/browser.js";
import type { BrowserClient } from "../../browser-client/types.js";
import type { OpenCodeTool } from "./opencode-tools.js";
import { agentToolbelt, runToolCalls } from "./toolbelt.js";
import type { AgentRunInput } from "./types.js";

/** A browser host stub that reports one created tab per create-tab call. */
function fakeBrowserClient(): BrowserClient & { states: BrowserState[] } {
  const states: BrowserState[] = [];
  return {
    protocol: { name: "browser", version: 1 },
    states,
    async execute(command) {
      if (command.type !== "create-tab")
        throw new Error(`unexpected command: ${command.type}`);
      const state: BrowserState = {
        generation: states.length + 1,
        sequence: states.length + 1,
        tabs: [
          ...(states.at(-1)?.tabs ?? []),
          {
            id: `tab-${states.length + 1}`,
            url: command.url ?? "",
            title: `Page ${states.length + 1}`,
            loading: false,
            canGoBack: false,
            canGoForward: false,
            error: null,
          },
        ],
        activeTabId: `tab-${states.length + 1}`,
      };
      states.push(state);
      return state;
    },
    async present() {},
    async release() {},
    async setOverlayRegions() {},
    async setModalOverlay() {},
    subscribe() {
      return () => undefined;
    },
  };
}

function runInput(
  overrides: Partial<AgentRunInput> = {},
): AgentRunInput & { appended: unknown[] } {
  const appended: unknown[] = [];
  return {
    prompt: "",
    folder: "/tmp/project",
    modelId: "test-model",
    reasoningEffort: null,
    providerSessionId: null,
    sessionId: "session-1",
    browserClient: fakeBrowserClient(),
    appendSessionTab: async (tab) => {
      appended.push(tab);
    },
    ...overrides,
    appended,
  } as AgentRunInput & { appended: unknown[] };
}

async function browserOpenTabTool(input: AgentRunInput): Promise<OpenCodeTool> {
  const { byName } = agentToolbelt(input, {
    name: "web_search",
    description: "",
    category: "read",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { output: "" };
    },
  });
  const tool = byName.get("browser_open_tab");
  assert.ok(tool, "browser_open_tab is offered");
  return tool;
}

test("browser_open_tab appends the opened page to the session's strip, focused", async () => {
  const input = runInput();
  const tool = await browserOpenTabTool(input);
  const result = await tool.execute(
    input.folder,
    { url: "https://hyos.dev" },
    new AbortController().signal,
  );
  assert.match(result.output, /Opened browser tab/);
  assert.deepEqual(input.appended, [
    { kind: "browser", url: "https://hyos.dev", title: "Page 1" },
  ]);
});

test("browser_open_tab still opens the tab without a session strip store", async () => {
  const input = runInput({ appendSessionTab: undefined });
  const tool = await browserOpenTabTool(input);
  const result = await tool.execute(
    input.folder,
    { url: "https://hyos.dev" },
    new AbortController().signal,
  );
  assert.match(result.output, /Opened browser tab/);
  assert.equal(input.appended.length, 0);
});

test("a failed strip write never fails the tool call", async () => {
  const input = runInput({
    appendSessionTab: async () => {
      throw new Error("db closed");
    },
  });
  const tool = await browserOpenTabTool(input);
  const result = await tool.execute(
    input.folder,
    { url: "https://hyos.dev" },
    new AbortController().signal,
  );
  assert.match(result.output, /Opened browser tab/);
});

test("summary intent offers no tools at all", () => {
  const { offered, byName } = agentToolbelt(runInput({ intent: "summary" }), {
    name: "web_search",
    description: "",
    category: "read",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { output: "" };
    },
  });
  assert.deepEqual(offered, []);
  assert.equal(byName.size, 0);
});

test("runToolCalls refuses to execute anything on a summary turn", async () => {
  const executed: string[] = [];
  const activities: { id: string; status: string }[] = [];
  const results = await runToolCalls({
    folder: "/tmp/project",
    intent: "summary",
    toolsByName: new Map([
      [
        "read",
        {
          name: "read",
          description: "",
          category: "read",
          parameters: { type: "object", properties: {} },
          async execute() {
            executed.push("read");
            return { output: "contents" };
          },
        } satisfies OpenCodeTool,
      ],
    ]),
    calls: [{ id: "call-1", name: "read", arguments: "{}" }],
    signal: new AbortController().signal,
    activity: async (id, _activity, status) => {
      activities.push({ id, status });
    },
    itemIdPrefix: "test",
  });
  assert.deepEqual(executed, []);
  assert.match(results[0].output, /Blocked/);
  assert.deepEqual(activities, [
    { id: "test:call-1", status: "streaming" },
    { id: "test:call-1", status: "failed" },
  ]);
});
