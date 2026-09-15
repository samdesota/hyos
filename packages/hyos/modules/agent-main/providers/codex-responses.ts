import type {
  AgentActivity,
  AgentMessageStatus,
  AgentReasoningEffort,
} from "../../../capabilities/agent.js";
import type { AgentRunImage } from "./types.js";
import type { OpenCodeTool } from "./opencode-tools.js";

/** ChatGPT-subscription Responses API endpoint the codex CLI talks to. */
export const CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";

/** Token usage reported by the codex backend for one response. */
export type CodexUsage = Readonly<{
  inputTokens: number;
  outputTokens: number | null;
}>;

/** One function tool call requested by the model. */
export type CodexFunctionCall = Readonly<{
  callId: string;
  name: string;
  arguments: string;
}>;

/**
 * Input items accepted by the Responses API. Fresh items are built with the
 * helpers below; completed items streamed by the backend (message, reasoning
 * with encrypted content, function_call) are replayed verbatim in the next
 * request because the codex backend runs with `store: false`.
 */
export type ResponsesInputItem =
  | Readonly<{
      type: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: readonly Readonly<
        | { type: "input_text" | "output_text"; text: string }
        | { type: "input_image"; image_url: string }
      >[];
    }>
  | Readonly<{
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }>
  | Readonly<{
      type: "function_call_output";
      call_id: string;
      output: string;
    }>;

export function userMessage(
  text: string,
  images?: readonly AgentRunImage[],
): ResponsesInputItem {
  return {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text },
      ...(images ?? []).map((image) => ({
        type: "input_image" as const,
        image_url: `data:${image.mimeType};base64,${image.base64}`,
      })),
    ],
  };
}

export function assistantMessage(text: string): ResponsesInputItem {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

export function functionCallItem(call: CodexFunctionCall): ResponsesInputItem {
  return {
    type: "function_call",
    call_id: call.callId,
    name: call.name,
    arguments: call.arguments,
  };
}

export function functionCallOutputItem(
  callId: string,
  output: string,
): ResponsesInputItem {
  return { type: "function_call_output", call_id: callId, output };
}

/** Convert a hyos tool to the Responses API function-tool shape (flat). */
export function responsesToolPayload(
  tool: OpenCodeTool,
): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

export function responsesRequestBody(
  input: Readonly<{
    model: string;
    instructions: string;
    input: readonly unknown[];
    tools: readonly OpenCodeTool[];
    effort: AgentReasoningEffort | null;
  }>,
): Record<string, unknown> {
  return {
    model: input.model,
    instructions: input.instructions,
    input: [...input.input],
    // No tools offered means a text-only round: omit the tools fields so the
    // API cannot be asked to choose among them.
    ...(input.tools.length > 0
      ? {
          tools: input.tools.map(responsesToolPayload),
          tool_choice: "auto",
          parallel_tool_calls: false,
        }
      : {}),
    ...(input.effort
      ? {
          reasoning: {
            effort: input.effort === "max" ? "high" : input.effort,
            summary: "auto",
          },
        }
      : {}),
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
}

/** Receives hyos activities mapped from the stream, mirroring AgentRunSink. */
export type CodexStreamHandlers = Readonly<{
  activity(
    providerItemId: string,
    activity: AgentActivity,
    status: AgentMessageStatus,
  ): void | Promise<void>;
}>;

export type CodexStreamResult = Readonly<{
  /**
   * Completed output items in arrival order. Replay them (plus
   * function_call_output items) in the next request's input.
   */
  items: readonly Record<string, unknown>[];
  /** Final assistant message text. */
  text: string;
  /** Tool calls to execute; activity reporting happens in the tool executor. */
  functionCalls: readonly CodexFunctionCall[];
  usage: CodexUsage | null;
}>;

async function* serverEvents(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error("Codex returned an empty response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const records = buffer.split(/\r?\n\r?\n/);
    buffer = records.pop() ?? "";
    for (const record of records) {
      for (const line of record.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        yield JSON.parse(data) as Record<string, unknown>;
      }
    }
    if (done) break;
  }
}

type StreamItem = Readonly<{
  id?: unknown;
  type?: unknown;
  role?: unknown;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
  content?: unknown;
  summary?: unknown;
}>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function outputTextOf(item: StreamItem): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => part as { type?: unknown; text?: unknown })
    .filter(
      (part) => part.type === "output_text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

function summaryTextOf(item: StreamItem): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  return summary
    .map((part) => part as { type?: unknown; text?: unknown })
    .filter(
      (part) => part.type === "summary_text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("\n\n");
}

function usageOf(response: unknown): CodexUsage | null {
  const usage = (
    response as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }
  )?.usage;
  if (typeof usage?.input_tokens !== "number") return null;
  return {
    inputTokens: usage.input_tokens,
    outputTokens:
      typeof usage.output_tokens === "number" ? usage.output_tokens : null,
  };
}

/**
 * Consume one streaming Responses API response: map reasoning to commentary
 * activities, accumulate the assistant text, collect tool calls, and return
 * the replayable items plus usage. The codex backend sends an empty
 * `response.output` in `response.completed`, so items are accumulated from
 * `response.output_item.done` events.
 */
export async function consumeResponsesStream(
  response: Response,
  handlers: CodexStreamHandlers,
): Promise<CodexStreamResult> {
  if (!response.ok)
    throw new Error(
      `Codex request failed: ${response.status} ${response.statusText}`,
    );

  const items: Record<string, unknown>[] = [];
  const reasoning = new Map<string, string>();
  const calls = new Map<
    string,
    { callId: string; name: string; arguments: string }
  >();
  const messageTexts = new Map<string, string>();
  let streamedText = "";
  let usage: CodexUsage | null = null;

  const emitReasoning = async (
    itemId: string,
    text: string,
    status: AgentMessageStatus,
  ): Promise<void> => {
    if (!text) return;
    await handlers.activity(
      `codex-reasoning:${itemId}`,
      { type: "commentary", text },
      status,
    );
  };

  for await (const event of serverEvents(response)) {
    switch (asString(event.type)) {
      case "response.output_item.added": {
        const item = (event.item ?? {}) as StreamItem;
        if (item.type === "function_call" && typeof item.id === "string")
          calls.set(item.id, {
            callId: asString(item.call_id),
            name: asString(item.name),
            arguments: asString(item.arguments),
          });
        if (item.type === "reasoning" && typeof item.id === "string")
          reasoning.set(item.id, "");
        break;
      }
      case "response.reasoning_summary_part.added": {
        const itemId = asString(event.item_id);
        const current = reasoning.get(itemId);
        if (
          current !== undefined &&
          typeof event.summary_index === "number" &&
          event.summary_index > 0
        )
          reasoning.set(itemId, `${current}\n\n`);
        break;
      }
      case "response.reasoning_summary_text.delta": {
        const itemId = asString(event.item_id);
        if (!reasoning.has(itemId)) reasoning.set(itemId, "");
        const next = `${reasoning.get(itemId) ?? ""}${asString(event.delta)}`;
        reasoning.set(itemId, next);
        await emitReasoning(itemId, next, "streaming");
        break;
      }
      case "response.function_call_arguments.delta": {
        const call = calls.get(asString(event.item_id));
        if (call) call.arguments += asString(event.delta);
        break;
      }
      case "response.function_call_arguments.done": {
        const call = calls.get(asString(event.item_id));
        if (call && typeof event.arguments === "string")
          call.arguments = event.arguments;
        break;
      }
      case "response.output_text.delta": {
        streamedText += asString(event.delta);
        break;
      }
      case "response.output_item.done": {
        const item = (event.item ?? {}) as StreamItem;
        items.push(item);
        if (item.type === "reasoning" && typeof item.id === "string") {
          const finalText =
            summaryTextOf(item) || (reasoning.get(item.id) ?? "");
          reasoning.set(item.id, finalText);
          await emitReasoning(item.id, finalText, "complete");
        }
        if (item.type === "function_call" && typeof item.id === "string") {
          const call = calls.get(item.id);
          if (call) {
            if (typeof item.call_id === "string") call.callId = item.call_id;
            if (typeof item.arguments === "string")
              call.arguments = item.arguments;
          } else {
            calls.set(item.id, {
              callId: asString(item.call_id),
              name: asString(item.name),
              arguments: asString(item.arguments),
            });
          }
        }
        if (item.type === "message" && typeof item.id === "string") {
          const finalText = outputTextOf(item);
          if (finalText) messageTexts.set(item.id, finalText);
        }
        break;
      }
      case "response.completed": {
        usage = usageOf(event.response);
        return {
          items,
          text: messageTexts.size
            ? [...messageTexts.values()].join("")
            : streamedText,
          functionCalls: [...calls.values()],
          usage,
        };
      }
      case "response.failed": {
        const failure = (event.response ?? {}) as {
          error?: { message?: unknown; code?: unknown };
        };
        throw new Error(
          `Codex stream failed: ${asString(failure.error?.message) || asString(failure.error?.code) || "unknown error"}`,
        );
      }
      case "response.incomplete": {
        const failure = (event.response ?? {}) as {
          incomplete_details?: { reason?: unknown };
        };
        throw new Error(
          `Codex response incomplete: ${asString(failure.incomplete_details?.reason) || "unknown reason"}`,
        );
      }
      case "error":
        throw new Error(
          `Codex stream failed: ${asString(event.message) || "unknown error"}`,
        );
      default:
        break;
    }
  }
  throw new Error("Codex stream closed before response.completed");
}
