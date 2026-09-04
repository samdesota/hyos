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
import { openCodeTools } from "./providers/opencode-tools.js";

const execFileAsync = promisify(execFile);

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
      ["read", "glob", "grep", "bash", "edit", "write"],
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
