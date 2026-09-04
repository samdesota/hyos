import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

import type { AgentActivity } from "../../../capabilities/agent.js";
import { contentDiff, createPatchActivity } from "./patches.js";
import { glmTurnPolicy } from "./glm-turn-policy.js";
import {
  openCodeTool,
  openCodeTools,
  type OpenCodeTool,
} from "./opencode-tools.js";
import { createParallelSearch } from "./parallel-search.js";
import type { AgentProvider, AgentRunSink } from "./types.js";

type GlmProviderConfig = Readonly<{
  apiKey?: string;
  apiKeyEnvironment?: string;
  environmentFile?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}>;

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: "system" | "user" | "tool"; content: string; tool_call_id?: string }
  | {
      role: "assistant";
      content: string;
      reasoning?: string;
      tool_calls?: readonly ToolCall[];
    };

type StreamUsage = Readonly<{
  prompt_tokens: number;
  completion_tokens?: number;
  total_tokens?: number;
}>;

type StreamDelta = Readonly<{
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: readonly Readonly<{
    index: number;
    id?: string;
    function?: Readonly<{ name?: string; arguments?: string }>;
  }>[];
}>;

const OPEN_WEIGHT_PROMPT = `You are HyOS, an interactive general AI coding agent running on a user's computer.

Take action with the available tools to complete the user's request. For coding work, inspect the existing codebase before editing, make actual file changes with edit or write, and verify them with bash. Code shown only in a text response is not saved. Prefer dedicated read, glob, and grep tools over shell commands for file inspection. Make minimal, maintainable changes that follow the project's existing conventions. Do not stop after a partial implementation; continue until the entire request is implemented and verified. Never perform git mutations unless the user explicitly asks.

Tool results may contain <system-reminder> directives. Treat those directives as authoritative. Be concise in user-visible text and never use tool calls as a substitute for communicating a final result.`;

/** Total context window for GLM models, in tokens. */
const GLM_CONTEXT_WINDOW = 800_000;

function environmentPrompt(folder: string, model: string): string {
  return `${OPEN_WEIGHT_PROMPT}

You are powered by ${model}.
<env>
  Working directory: ${folder}
  Platform: ${process.platform}
  OS version: ${os.release()}
  Today's date: ${new Date().toDateString()}
</env>`;
}

function toolsPayload(
  tools: typeof openCodeTools,
): readonly Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

async function* serverEvents(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error("GLM returned an empty response body");
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

async function errorText(response: Response): Promise<string> {
  const body = (await response.text()).trim();
  if (!body) return `${response.status} ${response.statusText}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? body;
  } catch {
    return body;
  }
}

/** Read a workspace file's content, or "" when it does not exist yet. */
async function readWorkspaceFile(
  folder: string,
  requestedPath: string,
): Promise<string> {
  try {
    return await readFile(path.resolve(folder, requestedPath), "utf8");
  } catch {
    return "";
  }
}

function activity(toolName: string, detail: string): AgentActivity {
  if (toolName === "web_search")
    return {
      type: "tool",
      category: "read",
      label: "Searched the web",
      detail,
    };
  if (toolName === "session_transcript")
    return {
      type: "tool",
      category: "read",
      label: "Read session transcript",
      detail,
    };
  const tool = openCodeTool(toolName);
  return {
    type: "tool",
    category: tool.category,
    label:
      tool.category === "read"
        ? "Read files"
        : tool.category === "command"
          ? "Ran a command"
          : "Edited files",
    detail,
  };
}

export function createGlmProvider(
  config: GlmProviderConfig = {},
): AgentProvider {
  const apiKeyEnvironment = config.apiKeyEnvironment ?? "AI_GATEWAY_API_KEY";
  const baseUrl = (config.baseUrl ?? "https://ai-gateway.vercel.sh/v1").replace(
    /\/$/,
    "",
  );
  const request = config.fetch ?? fetch;
  const search = createParallelSearch({
    environmentFile: config.environmentFile,
    fetch: config.fetch,
  });
  const tools = [...openCodeTools, search];
  let resolvedApiKey = config.apiKey ?? process.env[apiKeyEnvironment];
  const apiKey = async (): Promise<string> => {
    if (!resolvedApiKey && config.environmentFile) {
      const content = await readFile(config.environmentFile, "utf8");
      const entry = content
        .split(/\r?\n/)
        .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))
        .find((match) => match?.[1] === apiKeyEnvironment);
      resolvedApiKey = entry?.[2]?.trim().replace(/^(['"])(.*)\1$/, "$2");
    }
    if (resolvedApiKey) return resolvedApiKey;
    throw new Error(
      `GLM is not configured. Set ${apiKeyEnvironment} or add it to ${config.environmentFile ?? "the environment"}.`,
    );
  };

  return {
    summary: {
      id: "glm",
      label: "GLM",
      models: [
        {
          id: "zai/glm-5.3-flash",
          label: "GLM-5.3 Flash",
          reasoningEfforts: ["low", "medium", "high", "max"],
          defaultReasoningEffort: "medium",
        },
      ],
    },
    async prepare() {
      await apiKey();
    },
    async run(input, sink: AgentRunSink, signal) {
      const key = await apiKey();
      const policy = glmTurnPolicy(
        input,
        environmentPrompt(input.folder, input.modelId),
      );
      const offeredTools =
        input.intent === "investigate"
          ? tools.filter((tool) => tool.category !== "edit")
          : tools;
      const sessionTranscriptTool: OpenCodeTool | null = input.sessionTranscript
        ? {
            name: "session_transcript",
            description:
              'Read the full transcript of one earlier turn of this agent session — including its thinking and tool responses, which are omitted from the persisted transcript. Pass the turn id from the <turn id="..."> tag in the persisted transcript. The current turn\'s detail is not available.',
            category: "read",
            parameters: {
              type: "object",
              properties: {
                turnId: {
                  type: "string",
                  description:
                    'Id of an earlier turn, taken from the <turn id="..."> tag in the persisted transcript.',
                },
              },
              required: ["turnId"],
              additionalProperties: false,
            },
            async execute(_folder, args) {
              const turnId = typeof args.turnId === "string" ? args.turnId : "";
              if (!turnId) throw new Error("turnId is required");
              const transcript = await input.sessionTranscript!(turnId);
              if (transcript === null)
                throw new Error(
                  `No earlier turn with id "${turnId}". Turn ids appear in <turn id="..."> tags in the persisted transcript; the current turn is not available.`,
                );
              return { output: transcript };
            },
          }
        : null;
      const runTools = sessionTranscriptTool
        ? [...offeredTools, sessionTranscriptTool]
        : offeredTools;
      const toolsByName = new Map(
        [
          ...openCodeTools,
          search,
          ...(sessionTranscriptTool ? [sessionTranscriptTool] : []),
        ].map((tool) => [tool.name, tool]),
      );
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: policy.systemPrompt,
        },
        { role: "user", content: policy.prompt },
      ];
      let round = 0;
      while (true) {
        if (signal.aborted) throw new Error("Cancelled");
        const response = await request(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: input.modelId,
            messages,
            tools: toolsPayload(runTools),
            tool_choice: "auto",
            stream: true,
            stream_options: { include_usage: true },
            reasoning: { effort: policy.effort },
            max_tokens: 32_768,
            providerOptions: {
              gateway: {
                order: ["friendli", "baseten", "zai"],
                only: ["friendli", "baseten", "zai"],
              },
            },
          }),
          signal,
        });
        if (!response.ok)
          throw new Error(`GLM request failed: ${await errorText(response)}`);

        let content = "";
        let reasoning = "";
        let lastUsage: StreamUsage | null = null;
        const calls = new Map<number, ToolCall>();
        for await (const event of serverEvents(response)) {
          if (event.usage && typeof event.usage === "object") {
            lastUsage = event.usage as StreamUsage;
          }
          const choices = event.choices;
          if (!Array.isArray(choices) || choices.length === 0) continue;
          const delta = (choices[0] as { delta?: StreamDelta }).delta;
          if (!delta) continue;
          const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
          if (reasoningDelta) {
            reasoning += reasoningDelta;
            await sink.activity(
              `glm-thinking:${round}`,
              { type: "commentary", text: reasoning },
              "streaming",
            );
          }
          if (delta.content) content += delta.content;
          for (const fragment of delta.tool_calls ?? []) {
            const current = calls.get(fragment.index) ?? {
              id: fragment.id ?? `call-${round}-${fragment.index}`,
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            if (fragment.id) current.id = fragment.id;
            if (fragment.function?.name)
              current.function.name += fragment.function.name;
            if (fragment.function?.arguments)
              current.function.arguments += fragment.function.arguments;
            calls.set(fragment.index, current);
          }
        }
        if (reasoning) {
          await sink.activity(
            `glm-thinking:${round}`,
            { type: "commentary", text: reasoning },
            "complete",
          );
        }
        if (lastUsage && typeof lastUsage.prompt_tokens === "number") {
          await sink.usage?.({
            promptTokens: lastUsage.prompt_tokens,
            completionTokens:
              typeof lastUsage.completion_tokens === "number"
                ? lastUsage.completion_tokens
                : null,
            contextWindow: GLM_CONTEXT_WINDOW,
          });
        }

        const toolCalls = [...calls.values()];
        messages.push({
          role: "assistant",
          content,
          reasoning,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        if (toolCalls.length === 0) {
          if (content) await sink.response(content);
          return {
            providerSessionId: null,
            ...(lastUsage && typeof lastUsage.prompt_tokens === "number"
              ? {
                  usage: {
                    promptTokens: lastUsage.prompt_tokens,
                    completionTokens:
                      typeof lastUsage.completion_tokens === "number"
                        ? lastUsage.completion_tokens
                        : null,
                    contextWindow: GLM_CONTEXT_WINDOW,
                  },
                }
              : {}),
          };
        }
        if (content.trim()) {
          await sink.activity(
            `glm-commentary:${round}`,
            { type: "commentary", text: content },
            "complete",
          );
        }

        const results = await Promise.all(
          toolCalls.map(async (call) => {
            const providerItemId = `glm-tool:${call.id}`;
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(call.function.arguments || "{}") as Record<
                string,
                unknown
              >;
            } catch (error) {
              const message = `Invalid ${call.function.name} arguments: ${error instanceof Error ? error.message : String(error)}`;
              await sink.activity(
                providerItemId,
                activity(call.function.name, call.function.arguments),
                "failed",
              );
              return {
                role: "tool" as const,
                tool_call_id: call.id,
                content: message,
              };
            }
            await sink.activity(
              providerItemId,
              activity(call.function.name, JSON.stringify(args, null, 2)),
              "streaming",
            );
            try {
              const tool = toolsByName.get(call.function.name);
              if (!tool) throw new Error(`Unknown tool: ${call.function.name}`);
              if (input.intent === "investigate" && tool.category === "edit") {
                const message =
                  "Blocked: this is an investigate-only turn; edit and write tools are disabled.";
                await sink.activity(
                  providerItemId,
                  activity(call.function.name, JSON.stringify(args, null, 2)),
                  "failed",
                );
                return {
                  role: "tool" as const,
                  tool_call_id: call.id,
                  content: message,
                };
              }
              const editPaths =
                tool.category === "edit" && typeof args.filePath === "string"
                  ? [args.filePath]
                  : [];
              const before = new Map<string, string>();
              for (const editPath of editPaths) {
                before.set(
                  editPath,
                  await readWorkspaceFile(input.folder, editPath),
                );
              }
              const result = await tool.execute(input.folder, args, signal);
              if (tool.category === "edit" && result.paths) {
                const explanation =
                  typeof args.explanation === "string" ? args.explanation : "";
                const fallbackDiff = (
                  await Promise.all(
                    result.paths.map(async (editedPath) =>
                      contentDiff(
                        editedPath,
                        before.get(editedPath) ?? "",
                        await readWorkspaceFile(input.folder, editedPath),
                      ),
                    ),
                  )
                ).join("\n");
                await sink.activity(
                  providerItemId,
                  await createPatchActivity({
                    folder: input.folder,
                    explanation,
                    changes: result.paths.map((path) => ({
                      path,
                      kind: call.function.name === "write" ? "write" : "update",
                    })),
                    fallbackDiff,
                    preferFallbackDiff: true,
                  }),
                  "complete",
                );
              } else {
                await sink.activity(
                  providerItemId,
                  activity(call.function.name, result.output),
                  "complete",
                );
              }
              return {
                role: "tool" as const,
                tool_call_id: call.id,
                content: result.output || "Success",
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              await sink.activity(
                providerItemId,
                activity(call.function.name, message),
                "failed",
              );
              return {
                role: "tool" as const,
                tool_call_id: call.id,
                content: `Error: ${message}`,
              };
            }
          }),
        );
        messages.push(...results);
        round += 1;
      }
    },
  };
}
