import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentActivity,
  AgentMessageStatus,
} from "../../capabilities/agent.js";
import { CODEX_RESPONSES_URL } from "./providers/codex-responses.js";
import { createCodexProvider } from "./providers/codex.js";
import { createAgentProviders } from "./providers/index.js";
import type { AgentRunInput, AgentRunSink } from "./providers/types.js";

function sse(...events: readonly object[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}

/** Temporary directory holding a valid codex auth.json. */
async function authDirectoryFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hyos-codex-auth-"));
  await writeFile(
    join(directory, "auth.json"),
    JSON.stringify({
      tokens: { access_token: "tok-123", account_id: "acc-123" },
    }),
  );
  return directory;
}

type RecordedActivity = Readonly<{
  id: string;
  activity: AgentActivity;
  status: AgentMessageStatus;
}>;

function recordingSink(): {
  sink: AgentRunSink;
  activities: RecordedActivity[];
  responses: string[];
  usages: Record<string, unknown>[];
} {
  const activities: RecordedActivity[] = [];
  const responses: string[] = [];
  const usages: Record<string, unknown>[] = [];
  return {
    activities,
    responses,
    usages,
    sink: {
      session() {},
      usage(usage) {
        usages.push(usage);
      },
      response(content) {
        responses.push(content);
      },
      activity(id, activity, status) {
        activities.push({ id, activity, status });
      },
    },
  };
}

function runInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    prompt: "Inspect the workspace.",
    folder: "/tmp",
    modelId: "gpt-5.6-luna",
    providerSessionId: null,
    reasoningEffort: "medium",
    ...overrides,
  };
}

const reasoningEvents = (item: object) => [
  {
    type: "response.output_item.added",
    item: { id: "rs_1", type: "reasoning", summary: [] },
  },
  {
    type: "response.reasoning_summary_text.delta",
    item_id: "rs_1",
    delta: "Checking the notes first.",
  },
  { type: "response.output_item.done", item },
];

const finalEvents = (text: string, usage: object) => [
  {
    type: "response.output_item.done",
    item: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  },
  { type: "response.completed", response: { id: "resp_2", usage } },
];

test("codex runs the hyos tool loop over the ChatGPT-subscription backend", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-codex-"));
  const authDirectory = await authDirectoryFixture();
  await writeFile(join(folder, "notes.md"), "Secret notes\n");
  try {
    const requests: {
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }[] = [];
    let round = 0;
    const readArgs = JSON.stringify({ filePath: "notes.md" });
    const fakeFetch: typeof fetch = async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      round += 1;
      if (round === 1)
        return sse(
          { type: "response.created", response: { id: "resp_1" } },
          ...reasoningEvents({
            id: "rs_1",
            type: "reasoning",
            content: [],
            summary: [
              { type: "summary_text", text: "Checking the notes first." },
            ],
            encrypted_content: "enc-1",
          }),
          {
            type: "response.output_item.added",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_read",
              name: "read",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            delta: readArgs,
          },
          {
            type: "response.output_item.done",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_read",
              name: "read",
              arguments: readArgs,
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              usage: { input_tokens: 100, output_tokens: 20 },
            },
          },
        );
      return sse(
        ...finalEvents("The notes say hello.", {
          input_tokens: 200,
          output_tokens: 30,
        }),
      );
    };
    const provider = createCodexProvider({ authDirectory, fetch: fakeFetch });
    const { sink, activities, responses, usages } = recordingSink();
    const result = await provider.run(
      runInput({ folder }),
      sink,
      new AbortController().signal,
    );

    assert.equal(requests[0].url, CODEX_RESPONSES_URL);
    assert.equal(requests[0].headers.get("authorization"), "Bearer tok-123");
    assert.equal(requests[0].headers.get("chatgpt-account-id"), "acc-123");
    assert.equal(
      requests[0].headers.get("OpenAI-Beta"),
      "responses=experimental",
    );
    assert.equal(requests[0].body.model, "gpt-5.6-luna");
    assert.equal(requests[0].body.store, false);
    assert.equal(requests[0].body.stream, true);
    assert.match(String(requests[0].body.instructions), /You are HyOS/);
    assert.deepEqual(
      (requests[0].body.tools as { name: string }[]).map(({ name }) => name),
      ["read", "glob", "grep", "bash", "edit", "write", "web_search"],
    );
    assert.deepEqual(requests[0].body.reasoning, {
      effort: "medium",
      summary: "auto",
    });

    // Round 2 replays the backend's items plus the tool output.
    const input = requests[1].body.input as Record<string, unknown>[];
    assert.equal(input.length, 4);
    assert.equal(input[0].type, "message");
    assert.equal(input[1].type, "reasoning");
    assert.equal(input[1].encrypted_content, "enc-1");
    assert.equal(input[2].type, "function_call");
    assert.equal(input[3].type, "function_call_output");
    assert.equal(input[3].call_id, "call_read");
    assert.match(String(input[3].output), /Secret notes/);

    assert.deepEqual(responses, ["The notes say hello."]);
    assert.equal(result.providerSessionId, null);
    assert.deepEqual(result.usage, {
      promptTokens: 200,
      completionTokens: 30,
      contextWindow: 272_000,
    });
    assert.deepEqual(usages, [
      { promptTokens: 100, completionTokens: 20, contextWindow: 272_000 },
      { promptTokens: 200, completionTokens: 30, contextWindow: 272_000 },
    ]);
    const readActivity = activities
      .filter(({ id }) => id === "codex-tool:call_read")
      .at(-1);
    assert.ok(readActivity);
    assert.equal(readActivity.activity.type, "tool");
    assert.equal(readActivity.activity.label, "Read files");
    assert.equal(readActivity.status, "complete");
    assert.ok(
      activities.some(
        ({ id, status }) =>
          id === "codex-reasoning:rs_1" && status === "complete",
      ),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("codex writes files and reports patch activities", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-codex-"));
  const authDirectory = await authDirectoryFixture();
  try {
    const writeArgs = JSON.stringify({
      filePath: "answer.ts",
      content: "export const answer = 42;\n",
      explanation: "Create the requested answer module.",
    });
    let round = 0;
    const fakeFetch: typeof fetch = async (_url, init) => {
      round += 1;
      void init;
      if (round === 1)
        return sse(
          {
            type: "response.output_item.done",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_write",
              name: "write",
              arguments: writeArgs,
            },
          },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: { input_tokens: 50 } },
          },
        );
      return sse(
        ...finalEvents("Created answer.ts.", {
          input_tokens: 90,
          output_tokens: 10,
        }),
      );
    };
    const provider = createCodexProvider({ authDirectory, fetch: fakeFetch });
    const { sink, activities, responses } = recordingSink();
    const result = await provider.run(
      runInput({ folder }),
      sink,
      new AbortController().signal,
    );

    assert.equal(
      await readFile(join(folder, "answer.ts"), "utf8"),
      "export const answer = 42;\n",
    );
    const patch = activities.find(({ activity }) => activity.type === "patch");
    assert.ok(patch);
    assert.equal(patch.activity.type, "patch");
    if (patch.activity.type === "patch") {
      assert.deepEqual(patch.activity.changes, [
        { path: "answer.ts", kind: "write" },
      ]);
      assert.equal(
        patch.activity.explanation,
        "Create the requested answer module.",
      );
      assert.match(patch.activity.diff, /\+export const answer = 42;/);
    }
    assert.deepEqual(responses, ["Created answer.ts."]);
    assert.equal(result.providerSessionId, null);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("codex withholds edit tools and blocks them on investigate-only turns", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-codex-"));
  const authDirectory = await authDirectoryFixture();
  try {
    const writeArgs = JSON.stringify({
      filePath: "blocked.ts",
      content: "nope\n",
      explanation: "Should never be written.",
    });
    const requests: Record<string, unknown>[] = [];
    let round = 0;
    const fakeFetch: typeof fetch = async (_url, init) => {
      round += 1;
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (round === 1)
        return sse(
          {
            type: "response.output_item.done",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_blocked",
              name: "write",
              arguments: writeArgs,
            },
          },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: { input_tokens: 40 } },
          },
        );
      return sse(
        ...finalEvents("Investigation only.", {
          input_tokens: 80,
          output_tokens: 5,
        }),
      );
    };
    const provider = createCodexProvider({ authDirectory, fetch: fakeFetch });
    const { sink, activities } = recordingSink();
    await provider.run(
      runInput({ folder, intent: "investigate" }),
      sink,
      new AbortController().signal,
    );

    const offered = (requests[0].tools as { name: string }[]).map(
      ({ name }) => name,
    );
    assert.ok(!offered.includes("write"));
    assert.ok(!offered.includes("edit"));
    assert.ok(offered.includes("read"));

    const input = requests[1].input as Record<string, unknown>[];
    const output = input.at(-1) as { type: string; output: string };
    assert.equal(output.type, "function_call_output");
    assert.match(output.output, /Blocked: this is an investigate-only turn/);
    const blockedActivity = activities
      .filter(({ id }) => id === "codex-tool:call_blocked")
      .at(-1);
    assert.ok(blockedActivity);
    assert.equal(blockedActivity.status, "failed");
    await assert.rejects(readFile(join(folder, "blocked.ts"), "utf8"));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("codex maps reasoning effort into the request", async () => {
  const authDirectory = await authDirectoryFixture();
  const bodies: Record<string, unknown>[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sse(...finalEvents("Done.", { input_tokens: 10, output_tokens: 2 }));
  };
  const provider = createCodexProvider({ authDirectory, fetch: fakeFetch });
  await provider.run(
    runInput({ reasoningEffort: "max" }),
    recordingSink().sink,
    new AbortController().signal,
  );
  assert.deepEqual(bodies[0].reasoning, { effort: "high", summary: "auto" });
  await provider.run(
    runInput({ reasoningEffort: "low" }),
    recordingSink().sink,
    new AbortController().signal,
  );
  assert.deepEqual(bodies[1].reasoning, { effort: "low", summary: "auto" });
});

test("codex requires ChatGPT subscription auth before running", async () => {
  const provider = createCodexProvider({
    authDirectory: join(tmpdir(), "hyos-codex-missing-auth"),
  });
  await assert.rejects(() => provider.prepare!(), /codex login/);
});

test("codex surfaces HTTP errors and hints at re-login on 401", async () => {
  const authDirectory = await authDirectoryFixture();
  const provider = createCodexProvider({
    authDirectory,
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: "token expired" } }), {
        status: 401,
      }),
  });
  await assert.rejects(
    () =>
      provider.run(
        runInput(),
        recordingSink().sink,
        new AbortController().signal,
      ),
    /Codex request failed: token expired .*codex login/,
  );
});

test("createAgentProviders wires the codex auth directory override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hyos-codex-wiring-"));
  try {
    const providers = createAgentProviders(["codex"], {
      codex: { authDirectory: directory },
    });
    const provider = providers.get("codex");
    assert.ok(provider);
    // Without auth.json, preparation fails pointing at the override directory.
    await assert.rejects(
      () => provider.prepare!(),
      (error: unknown) => {
        assert.match(String(error), /no auth file at .*auth\.json/);
        assert.ok(String(error).includes(join(directory, "auth.json")));
        return true;
      },
    );
    // Once the CLI-style auth file exists in the override, preparation succeeds.
    await writeFile(
      join(directory, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "tok-1", account_id: "acc-1" },
      }),
    );
    await provider.prepare!();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("codex offers the gpt-6-astra model", () => {
  const { summary } = createCodexProvider();
  assert.ok(
    summary.models.some(
      (model) => model.id === "gpt-6-astra" && model.label === "GPT-6 Astra",
    ),
  );
});

test("codex models declare reasoning efforts so the reasoning picker renders", () => {
  const { summary } = createCodexProvider();
  assert.ok(summary.models.length > 0);
  for (const model of summary.models) {
    assert.deepEqual(model.reasoningEfforts, ["low", "medium", "high"]);
    assert.equal(model.defaultReasoningEffort, "medium");
  }
});
