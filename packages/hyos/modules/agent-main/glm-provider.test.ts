import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type {
  AgentActivity,
  AgentMessageStatus,
} from "../../capabilities/agent.js";
import { formatPlanBlock } from "../../capabilities/plan.js";
import { createGlmProvider } from "./providers/glm.js";
import type { AgentTokenUsage } from "./providers/types.js";
import {
  glmTurnPolicy,
  incrementalFirstRequest,
  incrementalImplementRule,
  incrementalPlanRule,
  incrementalReminder,
} from "./providers/glm-turn-policy.js";
import { openCodeTools } from "./providers/opencode-tools.js";

const execFileAsync = promisify(execFile);

test("GLM turn policy leaves standard unchanged and reminds every incremental request", () => {
  const input = {
    prompt: "Help me",
    folder: "/tmp",
    modelId: "glm",
    reasoningEffort: "high" as const,
    providerSessionId: null,
  };
  assert.deepEqual(glmTurnPolicy(input, "system"), {
    systemPrompt: "system",
    prompt: "Help me",
    effort: "high",
  });
  for (const firstTurn of [true, false]) {
    const policy = glmTurnPolicy(
      { ...input, mode: "incremental", firstTurn },
      "system",
    );
    assert.equal(policy.effort, "low");
    assert.equal(policy.prompt.includes(incrementalFirstRequest), firstTurn);
    assert.ok(policy.prompt.endsWith(incrementalReminder));
    assert.match(
      policy.systemPrompt,
      /conversational response without tools or file changes is a valid result/,
    );
  }
  const implement = glmTurnPolicy(
    { ...input, mode: "incremental", intent: "implement" },
    "system",
  );
  assert.ok(implement.prompt.includes(incrementalImplementRule));
  const investigate = glmTurnPolicy(
    { ...input, mode: "incremental", intent: "investigate" },
    "system",
  );
  assert.ok(!investigate.prompt.includes(incrementalImplementRule));
  const standard = glmTurnPolicy({ ...input, intent: "implement" }, "system");
  assert.ok(!standard.prompt.includes(incrementalImplementRule));
});

test("incremental turns open with the persisted plan and keep it updated", () => {
  const input = {
    prompt: "Do the next step",
    folder: "/tmp",
    modelId: "glm",
    reasoningEffort: "high" as const,
    providerSessionId: null,
  };
  const bare = glmTurnPolicy({ ...input, mode: "incremental" }, "system");
  assert.ok(bare.prompt.startsWith("Do the next step"));
  assert.ok(bare.prompt.includes(incrementalPlanRule));

  const tasks = [
    { text: "Plan format + prompt policy", done: true },
    { text: "Plan parser", done: false },
  ] as const;
  const planned = glmTurnPolicy(
    { ...input, mode: "incremental", plan: { tasks } },
    "system",
  );
  const block = formatPlanBlock(tasks);
  assert.ok(planned.prompt.startsWith(`${block}\n\n`));
  assert.ok(planned.prompt.includes("current plan of record"));
  assert.ok(planned.prompt.includes(incrementalPlanRule));
  assert.ok(planned.prompt.includes("Do the next step"));

  // The plan never leaks into standard mode.
  const standard = glmTurnPolicy({ ...input, plan: { tasks } }, "system");
  assert.equal(standard.prompt, "Do the next step");
});

test("GLM incremental requests can finish conversationally without edits", async () => {
  for (const firstTurn of [true, false]) {
    let calls = 0;
    let response = "";
    const provider = createGlmProvider({
      apiKey: "test",
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.reasoning, { effort: "low" });
        assert.ok(body.messages[1].content.endsWith(incrementalReminder));
        assert.equal(
          body.messages[1].content.includes(incrementalFirstRequest),
          firstTurn,
        );
        return stream({
          choices: [
            { delta: { content: "Here is the first step. Shall I proceed?" } },
          ],
        });
      },
    });
    const result = await provider.run(
      {
        prompt: "Plan this",
        folder: "/tmp",
        modelId: "glm",
        reasoningEffort: "high",
        providerSessionId: null,
        mode: "incremental",
        firstTurn,
      },
      {
        session() {},
        activity() {},
        response(content) {
          response += content;
        },
      },
      new AbortController().signal,
    );
    assert.equal(calls, 1);
    assert.match(response, /Shall I proceed/);
    assert.equal(result.providerSessionId, null);
  }
});

test("GLM-5.2 sends the non-thinking payload in incremental mode only", async () => {
  const requests: Record<string, unknown>[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return stream({ choices: [{ delta: { content: "Done." } }] });
  };
  const provider = createGlmProvider({ apiKey: "test", fetch: fakeFetch });
  const run = (overrides: Record<string, unknown>) =>
    provider.run(
      {
        prompt: "Go.",
        folder: "/tmp",
        modelId: "zai/glm-5.2",
        providerSessionId: null,
        reasoningEffort: "high",
        ...overrides,
      },
      { session() {}, activity() {}, response() {} },
      new AbortController().signal,
    );

  await run({ mode: "incremental" });
  assert.deepEqual(requests[0].reasoning, { effort: "none" });

  await run({});
  assert.deepEqual(requests[1].reasoning, { effort: "high" });

  // Other models keep their policy effort in incremental mode.
  await run({ modelId: "zai/glm-5.3-flash", mode: "incremental" });
  assert.deepEqual(requests[2].reasoning, { effort: "low" });
});

test("GLM reports per-turn context usage from stream chunks", async () => {
  const requests: Record<string, unknown>[] = [];
  const usages: AgentTokenUsage[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return stream(
      { choices: [{ delta: { content: "Done." } }] },
      {
        usage: {
          prompt_tokens: 42_300,
          completion_tokens: 128,
          total_tokens: 42_428,
        },
      },
    );
  };
  const provider = createGlmProvider({ apiKey: "test", fetch: fakeFetch });
  const result = await provider.run(
    {
      prompt: "Measure context.",
      folder: "/tmp",
      modelId: "zai/glm-5.3-flash",
      providerSessionId: null,
      reasoningEffort: "medium",
    },
    {
      session() {},
      usage(usage) {
        usages.push(usage);
      },
      response() {},
      activity() {},
    },
    new AbortController().signal,
  );
  assert.equal(result.providerSessionId, null);
  assert.deepEqual(result.usage, {
    promptTokens: 42_300,
    completionTokens: 128,
    contextWindow: 800_000,
  });
  assert.deepEqual(usages, [
    { promptTokens: 42_300, completionTokens: 128, contextWindow: 800_000 },
  ]);
  assert.deepEqual(requests[0].stream_options, { include_usage: true });
  assert.deepEqual(requests[0].providerOptions, {
    gateway: {
      order: ["baseten", "friendli", "zai"],
      only: ["baseten", "friendli", "zai"],
    },
  });
});

test("gateway models report per-model context windows and routing", async () => {
  const glmRouting = {
    gateway: {
      order: ["baseten", "friendli", "zai"],
      only: ["baseten", "friendli", "zai"],
    },
  };
  const deepSeekProRouting = {
    gateway: {
      order: ["baseten", "deepinfra"],
      only: ["baseten", "deepinfra"],
    },
  };
  const cases = [
    { modelId: "zai/glm-5.2", providerOptions: glmRouting },
    {
      modelId: "deepseek/deepseek-v4-pro",
      providerOptions: deepSeekProRouting,
    },
    { modelId: "deepseek/deepseek-v4-flash", providerOptions: null },
    { modelId: "alibaba/qwen3.5-plus", providerOptions: null },
  ] as const;
  for (const { modelId, providerOptions } of cases) {
    const requests: Record<string, unknown>[] = [];
    const usages: AgentTokenUsage[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return stream(
        { choices: [{ delta: { content: "Done." } }] },
        {
          usage: { prompt_tokens: 1_200, completion_tokens: 64 },
        },
      );
    };
    const provider = createGlmProvider({ apiKey: "test", fetch: fakeFetch });
    const result = await provider.run(
      {
        prompt: "Measure context.",
        folder: "/tmp",
        modelId,
        providerSessionId: null,
        reasoningEffort: "low",
      },
      {
        session() {},
        usage(usage) {
          usages.push(usage);
        },
        response() {},
        activity() {},
      },
      new AbortController().signal,
    );
    assert.equal(requests[0].model as string | undefined, modelId);
    assert.deepEqual(requests[0].reasoning, { effort: "low" });
    if (providerOptions) {
      assert.deepEqual(requests[0].providerOptions, providerOptions);
    } else {
      assert.equal("providerOptions" in requests[0], false);
    }
    const expected = {
      promptTokens: 1_200,
      completionTokens: 64,
      contextWindow: 1_000_000,
    };
    assert.deepEqual(result.usage, expected);
    assert.deepEqual(usages, [expected]);
  }
});

function stream(...events: readonly object[]): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

test("GLM exposes the OpenCode tool interface with explained edits", () => {
  assert.deepEqual(
    openCodeTools.map(({ name }) => name),
    ["read", "glob", "grep", "bash", "edit", "write"],
  );
  const edit = openCodeTools.find(({ name }) => name === "edit")!;
  const write = openCodeTools.find(({ name }) => name === "write")!;
  assert.deepEqual(edit.parameters.required, [
    "filePath",
    "oldString",
    "newString",
    "explanation",
  ]);
  assert.deepEqual(write.parameters.required, [
    "content",
    "filePath",
    "explanation",
  ]);
  const model = createGlmProvider({ apiKey: "test" }).summary.models[0];
  assert.equal(model.defaultReasoningEffort, "medium");
  assert.deepEqual(model.reasoningEfforts, ["low", "medium", "high", "max"]);
});

test("the gateway catalog lists the GLM, DeepSeek, and Qwen models", () => {
  const { id, label, models } = createGlmProvider({ apiKey: "test" }).summary;
  assert.equal(id, "glm");
  assert.deepEqual(
    models.map(({ id: modelId, label: modelLabel }) => [modelId, modelLabel]),
    [
      ["zai/glm-5.3-flash", "GLM-5.3 Flash"],
      ["zai/glm-5.2", "GLM-5.2"],
      ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"],
      ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"],
      ["alibaba/qwen3.5-plus", "Qwen3.5 Plus"],
    ],
  );
  // GLM-5.3 Flash keeps its old default; the open-weight models the user is
  // benchmarking start at low reasoning effort.
  for (const model of models) {
    assert.deepEqual(model.reasoningEfforts, ["low", "medium", "high", "max"]);
    assert.equal(
      model.defaultReasoningEffort,
      model.id === "zai/glm-5.3-flash" ? "medium" : "low",
    );
  }
  assert.equal(label, "AI Gateway");
});

test("GLM streams reasoning, executes tools, and continues to a final response", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-glm-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: folder });
  const requests: Record<string, unknown>[] = [];
  let requestIndex = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    requestIndex += 1;
    if (requestIndex === 1) {
      return stream(
        {
          choices: [
            {
              delta: {
                reasoning_content: "I need to create the requested file.",
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                content: "Creating the module.",
                tool_calls: [
                  {
                    index: 0,
                    id: "write-1",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({
                        filePath: join(folder, "answer.ts"),
                        content: "export const answer = 42;\n",
                        explanation: "Create the requested answer module.",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      );
    }
    return stream({
      choices: [{ delta: { content: "Implemented and verified." } }],
    });
  };
  const activities: Array<{
    id: string;
    activity: AgentActivity;
    status: AgentMessageStatus;
  }> = [];
  const responses: string[] = [];
  try {
    const provider = createGlmProvider({ apiKey: "test", fetch: fakeFetch });
    const result = await provider.run(
      {
        prompt: "Create an answer module.",
        folder,
        modelId: "zai/glm-5.3-flash",
        providerSessionId: null,
        reasoningEffort: "medium",
      },
      {
        session() {},
        response(content) {
          responses.push(content);
        },
        activity(id, activity, status) {
          activities.push({ id, activity, status });
        },
      },
      new AbortController().signal,
    );

    assert.equal(result.providerSessionId, null);
    assert.equal(
      await readFile(join(folder, "answer.ts"), "utf8"),
      "export const answer = 42;\n",
    );
    assert.deepEqual(responses, ["Implemented and verified."]);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].reasoning, { effort: "medium" });
    assert.deepEqual(
      (requests[0].tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      ),
      ["read", "glob", "grep", "bash", "edit", "write", "web_search"],
    );
    assert.ok(
      activities.some(
        ({ activity, status }) =>
          activity.type === "commentary" &&
          activity.text.includes("create the requested file") &&
          status === "streaming",
      ),
    );
    assert.ok(
      activities.some(
        ({ activity, status }) =>
          activity.type === "patch" &&
          activity.explanation === "Create the requested answer module." &&
          status === "complete",
      ),
    );
    const secondMessages = requests[1].messages as Array<{ role: string }>;
    assert.equal(secondMessages.at(-1)?.role, "tool");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("GLM investigate turns hide edit/write tools and deny edit calls", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-glm-investigate-"));
  const requests: Record<string, unknown>[] = [];
  let requestIndex = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    requestIndex += 1;
    if (requestIndex === 1) {
      return stream({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "edit-1",
                  function: {
                    name: "edit",
                    arguments: JSON.stringify({
                      filePath: join(folder, "answer.ts"),
                      oldString: "",
                      newString: "export const answer = 42;\n",
                      explanation: "Try to edit anyway.",
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    }
    return stream({
      choices: [{ delta: { content: "Investigated read-only." } }],
    });
  };
  const activities: Array<{ activity: AgentActivity; status: string }> = [];
  const responses: string[] = [];
  try {
    const provider = createGlmProvider({ apiKey: "test", fetch: fakeFetch });
    await provider.run(
      {
        prompt: "Investigate this.",
        folder,
        modelId: "zai/glm-5.3-flash",
        providerSessionId: null,
        reasoningEffort: "medium",
        intent: "investigate",
      },
      {
        session() {},
        response(content) {
          responses.push(content);
        },
        activity(_id, activity, status) {
          activities.push({ activity, status });
        },
      },
      new AbortController().signal,
    );
    const toolNames = (
      requests[0].tools as Array<{ function: { name: string } }>
    ).map((tool) => tool.function.name);
    assert.ok(!toolNames.includes("edit"));
    assert.ok(!toolNames.includes("write"));
    assert.ok(toolNames.includes("bash"));
    assert.deepEqual(responses, ["Investigated read-only."]);
    const lastMessages = requests[1].messages as Array<{
      role: string;
      content: string;
    }>;
    assert.equal(lastMessages.at(-1)?.role, "tool");
    assert.match(lastMessages.at(-1)!.content, /investigate-only turn/);
    assert.ok(activities.some(({ activity, status }) => status === "failed"));
    await assert.rejects(() => readFile(join(folder, "answer.ts"), "utf8"));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("GLM reports a missing API key before starting a session", async () => {
  const provider = createGlmProvider({
    apiKeyEnvironment: "HYOS_TEST_MISSING_GLM_KEY",
  });
  await assert.rejects(() => provider.prepare!(), /HYOS_TEST_MISSING_GLM_KEY/);
});

test("GLM loads its gateway key from a configured environment file", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-glm-env-"));
  try {
    const environmentFile = join(folder, ".env");
    await writeFile(environmentFile, "TEST_AI_GATEWAY_KEY='test-key'\n");
    const provider = createGlmProvider({
      apiKeyEnvironment: "TEST_AI_GATEWAY_KEY",
      environmentFile,
    });
    await provider.prepare!();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
