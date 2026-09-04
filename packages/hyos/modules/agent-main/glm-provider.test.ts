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
import { createGlmProvider } from "./providers/glm.js";
import {
  glmTurnPolicy,
  incrementalFirstRequest,
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
