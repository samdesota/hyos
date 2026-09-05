import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentActivity,
  AgentMessageStatus,
} from "../../capabilities/agent.js";
import {
  CODEX_RESPONSES_URL,
  assistantMessage,
  consumeResponsesStream,
  functionCallItem,
  functionCallOutputItem,
  responsesRequestBody,
  responsesToolPayload,
  userMessage,
} from "./providers/codex-responses.js";
import type { CodexStreamHandlers } from "./providers/codex-responses.js";
import type { OpenCodeTool } from "./providers/opencode-tools.js";

const readTool: OpenCodeTool = {
  name: "get_time",
  description: "Returns the current time.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  category: "read",
  async execute() {
    return { output: "14:03:22" };
  },
};

function sseResponse(events: readonly unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}

function activityCollector(): {
  calls: { id: string; text: string; status: AgentMessageStatus }[];
  handlers: CodexStreamHandlers;
} {
  const calls: { id: string; text: string; status: AgentMessageStatus }[] = [];
  return {
    calls,
    handlers: {
      activity(
        _providerItemId: string,
        activity: AgentActivity,
        status: AgentMessageStatus,
      ) {
        calls.push({
          id: _providerItemId,
          text: activity.type === "commentary" ? activity.text : "",
          status,
        });
      },
    },
  };
}

test("builds Responses API request bodies and item payloads", () => {
  const body = responsesRequestBody({
    model: "gpt-5.6-luna",
    instructions: "You are HyOS.",
    input: [
      userMessage("hi"),
      assistantMessage("Hello"),
      functionCallItem({ callId: "call_1", name: "get_time", arguments: "{}" }),
      functionCallOutputItem("call_1", "14:03"),
    ],
    tools: [readTool],
    effort: "max",
  });
  assert.deepEqual(body, {
    model: "gpt-5.6-luna",
    instructions: "You are HyOS.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello" }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_time",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "14:03" },
    ],
    tools: [
      {
        type: "function",
        name: "get_time",
        description: "Returns the current time.",
        parameters: readTool.parameters,
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "high", summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  });
  assert.equal(
    responsesRequestBody({
      model: "m",
      instructions: "i",
      input: [],
      tools: [],
      effort: null,
    }).reasoning,
    undefined,
  );
  assert.equal(
    CODEX_RESPONSES_URL,
    "https://chatgpt.com/backend-api/codex/responses",
  );
});

test("maps reasoning, function calls, text and usage from a codex stream", async () => {
  const { calls, handlers } = activityCollector();
  const result = await consumeResponsesStream(
    sseResponse([
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.output_item.added",
        item: { id: "rs_1", type: "reasoning", summary: [] },
      },
      {
        type: "response.reasoning_summary_part.added",
        item_id: "rs_1",
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        delta: "**Calculating 391**",
      },
      {
        type: "response.output_item.done",
        item: {
          id: "rs_1",
          type: "reasoning",
          content: [],
          summary: [{ type: "summary_text", text: "**Calculating 391**" }],
          encrypted_content: "enc-1",
        },
      },
      {
        type: "response.output_item.added",
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "get_time",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: "{}",
      },
      {
        type: "response.output_item.done",
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "get_time",
          arguments: "{}",
        },
      },
      {
        type: "response.output_item.added",
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello " },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "world" },
      {
        type: "response.output_item.done",
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello world" }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          usage: { input_tokens: 139, output_tokens: 14, total_tokens: 153 },
          output: [],
        },
      },
    ]),
    handlers,
  );
  assert.equal(result.text, "Hello world");
  assert.deepEqual(result.functionCalls, [
    { callId: "call_1", name: "get_time", arguments: "{}" },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 139, outputTokens: 14 });
  assert.deepEqual(
    result.items.map((item) => item.type),
    ["reasoning", "function_call", "message"],
  );
  assert.equal(result.items[0].encrypted_content, "enc-1");
  assert.deepEqual(calls, [
    {
      id: "codex-reasoning:rs_1",
      text: "**Calculating 391**",
      status: "streaming",
    },
    {
      id: "codex-reasoning:rs_1",
      text: "**Calculating 391**",
      status: "complete",
    },
  ]);
});

test("takes assistant text from completed items when no deltas stream", async () => {
  const { handlers } = activityCollector();
  const result = await consumeResponsesStream(
    sseResponse([
      {
        type: "response.output_item.done",
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "17 × 23 = 391." }],
        },
      },
      { type: "response.completed", response: { id: "resp_2", usage: {} } },
    ]),
    handlers,
  );
  assert.equal(result.text, "17 × 23 = 391.");
  assert.deepEqual(result.functionCalls, []);
  assert.equal(result.usage, null);
});

test("accumulates function arguments across deltas and honors the done payload", async () => {
  const { handlers } = activityCollector();
  const result = await consumeResponsesStream(
    sseResponse([
      {
        type: "response.output_item.added",
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_9",
          name: "edit",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"filePath":',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '"a.ts"}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        arguments: '{"filePath":"a.ts"}',
      },
      {
        type: "response.completed",
        response: { id: "resp_3", usage: { input_tokens: 5 } },
      },
    ]),
    handlers,
  );
  assert.deepEqual(result.functionCalls, [
    { callId: "call_9", name: "edit", arguments: '{"filePath":"a.ts"}' },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: null });
});

test("separates multi-part reasoning summaries", async () => {
  const { calls, handlers } = activityCollector();
  await consumeResponsesStream(
    sseResponse([
      {
        type: "response.output_item.added",
        item: { id: "rs_1", type: "reasoning", summary: [] },
      },
      {
        type: "response.reasoning_summary_part.added",
        item_id: "rs_1",
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        delta: "Part one",
      },
      {
        type: "response.reasoning_summary_part.added",
        item_id: "rs_1",
        summary_index: 1,
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        delta: "Part two",
      },
      {
        type: "response.output_item.done",
        item: {
          id: "rs_1",
          type: "reasoning",
          summary: [
            { type: "summary_text", text: "Part one" },
            { type: "summary_text", text: "Part two" },
          ],
        },
      },
      { type: "response.completed", response: { id: "resp_4" } },
    ]),
    handlers,
  );
  assert.deepEqual(calls, [
    { id: "codex-reasoning:rs_1", text: "Part one", status: "streaming" },
    {
      id: "codex-reasoning:rs_1",
      text: "Part one\n\nPart two",
      status: "streaming",
    },
    {
      id: "codex-reasoning:rs_1",
      text: "Part one\n\nPart two",
      status: "complete",
    },
  ]);
});

test("surfaces stream failures and truncated streams", async () => {
  const { handlers } = activityCollector();
  await assert.rejects(
    consumeResponsesStream(
      sseResponse([
        {
          type: "response.failed",
          response: { error: { code: "server_error", message: "boom" } },
        },
      ]),
      handlers,
    ),
    /^Error: Codex stream failed: boom$/,
  );
  await assert.rejects(
    consumeResponsesStream(
      sseResponse([{ type: "error", message: "bad gateway" }]),
      handlers,
    ),
    /^Error: Codex stream failed: bad gateway$/,
  );
  await assert.rejects(
    consumeResponsesStream(sseResponse([]), handlers),
    /^Error: Codex stream closed before response.completed$/,
  );
  await assert.rejects(
    consumeResponsesStream(new Response("no", { status: 500 }), handlers),
    /^Error: Codex request failed: 500 /,
  );
});

test("parses SSE records split across arbitrary chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'event: response.created\ndata: {"type":"resp',
    'onse.created","response":{"id":"r"}}\n\ndata: {"type":"response.comp',
    'leted","response":{"usage":{"input_tokens":7,"output_tokens":2}}}\n\n',
  ];
  const { handlers } = activityCollector();
  const result = await consumeResponsesStream(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
    ),
    handlers,
  );
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 2 });
});
