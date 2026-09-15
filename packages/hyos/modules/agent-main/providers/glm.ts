import { readFile } from "node:fs/promises";

import type { AgentReasoningEffort } from "../../../capabilities/agent.js";
import { glmTurnPolicy } from "./glm-turn-policy.js";
import { environmentPrompt } from "./prompt.js";
import type { OpenCodeTool } from "./opencode-tools.js";
import { createParallelSearch } from "./parallel-search.js";
import { agentToolbelt, runToolCalls } from "./toolbelt.js";
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
  | {
      role: "system" | "user" | "tool";
      content:
        | string
        | readonly Readonly<
            | { type: "text"; text: string }
            | { type: "image_url"; image_url: { url: string } }
          >[];
      tool_call_id?: string;
    }
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

/** Total context window to assume for an unknown model id, in tokens. */
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/** Reasoning efforts accepted by the gateway for every listed model. */
const REASONING_EFFORTS: readonly AgentReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "max",
];

/**
 * Gateway providers serving the GLM family, preferred order first. Baseten
 * leads: it honors reasoning effort and skips thinking on easy prompts at the
 * lowest cost. Zai and fireworks follow as failover — both honor effort and
 * think far deeper at `max` on hard prompts. Friendli is excluded: it ignores
 * effort and always reasons.
 */
const GLM_GATEWAY_PROVIDERS = ["baseten", "zai", "fireworks"] as const;

/** DeepSeek V4 Pro is served by baseten (preferred) and deepinfra only. */
const DEEPSEEK_V4_PRO_GATEWAY_PROVIDERS = ["baseten", "deepinfra"] as const;

type GatewayModel = Readonly<{
  id: string;
  label: string;
  /** Reasoning effort used when the user has not chosen one. */
  defaultReasoningEffort: AgentReasoningEffort;
  /** Total context window reported by the gateway, in tokens. */
  contextWindow: number;
  /** Gateway routing preferences; unset lets the gateway auto-route. */
  providerOptions?: Record<string, unknown>;
  /**
   * Send the gateway's documented non-thinking payload
   * (`reasoning: { effort: "none" }`) in incremental mode.
   */
  nonThinkingIncremental?: boolean;
}>;

/**
 * Models served through the AI gateway. Open-weight models default to low
 * reasoning effort: they overthink at higher efforts, and the user is
 * benchmarking how much thinking each model actually does.
 */
const GATEWAY_MODELS: readonly GatewayModel[] = [
  {
    id: "zai/glm-5.3-flash",
    label: "GLM-5.3 Flash",
    defaultReasoningEffort: "medium",
    contextWindow: 800_000,
    providerOptions: {
      gateway: { order: GLM_GATEWAY_PROVIDERS, only: GLM_GATEWAY_PROVIDERS },
    },
  },
  {
    id: "zai/glm-5.2",
    label: "GLM-5.2",
    defaultReasoningEffort: "low",
    contextWindow: 1_000_000,
    nonThinkingIncremental: true,
    providerOptions: {
      gateway: { order: GLM_GATEWAY_PROVIDERS, only: GLM_GATEWAY_PROVIDERS },
    },
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    defaultReasoningEffort: "low",
    contextWindow: 1_000_000,
    providerOptions: {
      gateway: {
        order: DEEPSEEK_V4_PRO_GATEWAY_PROVIDERS,
        only: DEEPSEEK_V4_PRO_GATEWAY_PROVIDERS,
      },
    },
  },
  {
    id: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    defaultReasoningEffort: "low",
    contextWindow: 1_000_000,
  },
  {
    id: "alibaba/qwen3.5-plus",
    label: "Qwen3.5 Plus",
    defaultReasoningEffort: "low",
    contextWindow: 1_000_000,
  },
];

function gatewayModel(modelId: string): GatewayModel | null {
  return GATEWAY_MODELS.find((model) => model.id === modelId) ?? null;
}

/** Cheap fast model used for one-shot session title generation. */
const TITLE_MODEL = "zai/glm-5.3-flash";

/** Give up on title generation quickly; it must never delay the turn. */
const TITLE_TIMEOUT_MS = 10_000;

const TITLE_SYSTEM_PROMPT =
  "You write short conversation titles. Given the user's first message, reply " +
  "with a 3-5 word title that captures the task. Reply with the title only: " +
  "no quotes, no trailing punctuation, no explanation.";

const STATUS_DETAIL_SYSTEM_PROMPT =
  "You write short status lines for a coding agent's sidebar. Given the task " +
  "the agent is working on — either about to start or just finished — reply " +
  "with a 3-5 word phrase describing the work, e.g. 'Fix login race " +
  "condition'. Reply with the phrase only: no quotes, no trailing " +
  "punctuation, no explanation.";

/** Collapse a model reply to a single tidy title line, or "" when unusable. */
function cleanGeneratedTitle(raw: string): string {
  const firstLine = raw.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine
    .replace(/^["'“”‘’`*#\s]+/, "")
    .replace(/["'“”‘’`*#\s]+$/, "")
    .trim();
}

function toolsPayload(
  tools: readonly OpenCodeTool[],
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

  /** One cheap non-streaming low-reasoning completion, or null on any failure. */
  const oneShot = async (
    systemPrompt: string,
    userContent: string,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    try {
      const key = await apiKey();
      const response = await request(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: TITLE_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          stream: false,
          reasoning: { effort: "low" },
          max_tokens: 64,
        }),
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(TITLE_TIMEOUT_MS),
        ]),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        choices?: readonly { message?: { content?: string } }[];
      };
      return (
        cleanGeneratedTitle(payload.choices?.[0]?.message?.content ?? "") ||
        null
      );
    } catch {
      return null;
    }
  };

  return {
    summary: {
      id: "glm",
      label: "AI Gateway",
      models: GATEWAY_MODELS.map((model) => ({
        id: model.id,
        label: model.label,
        reasoningEfforts: REASONING_EFFORTS,
        defaultReasoningEffort: model.defaultReasoningEffort,
      })),
    },
    async prepare() {
      await apiKey();
    },
    async generateTitle(prompt, signal) {
      return oneShot(TITLE_SYSTEM_PROMPT, prompt, signal);
    },
    async generateStatusDetail(prompt, previousResponse, signal) {
      const input = previousResponse
        ? `${prompt}\n\n(The agent is continuing from its previous reply, which ended with:)\n${previousResponse.slice(-600)}`
        : prompt;
      return oneShot(STATUS_DETAIL_SYSTEM_PROMPT, input, signal);
    },
    async run(input, sink: AgentRunSink, signal) {
      const key = await apiKey();
      const model = gatewayModel(input.modelId);
      const contextWindow = model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const policy = glmTurnPolicy(
        input,
        environmentPrompt(input.folder, input.modelId),
      );
      const nonThinking =
        input.mode === "incremental" && model?.nonThinkingIncremental === true;
      const { offered, byName } = agentToolbelt(input, search);
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: policy.systemPrompt,
        },
        {
          role: "user",
          // Composer images ride on the opening user message as native
          // image_url parts (data URLs); text-only turns stay a plain string.
          content:
            input.images && input.images.length > 0
              ? [
                  { type: "text" as const, text: policy.prompt },
                  ...input.images.map((image) => ({
                    type: "image_url" as const,
                    image_url: {
                      url: `data:${image.mimeType};base64,${image.base64}`,
                    },
                  })),
                ]
              : policy.prompt,
        },
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
            ...(offered.length > 0
              ? { tools: toolsPayload(offered), tool_choice: "auto" as const }
              : {}),
            stream: true,
            stream_options: { include_usage: true },
            reasoning: nonThinking
              ? { effort: "none" }
              : { effort: policy.effort },
            max_tokens: 32_768,
            ...(model?.providerOptions
              ? { providerOptions: model.providerOptions }
              : {}),
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
            contextWindow,
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
                    contextWindow,
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

        const results = await runToolCalls({
          folder: input.folder,
          intent: input.intent,
          toolsByName: byName,
          calls: toolCalls.map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          })),
          signal,
          activity: sink.activity,
          itemIdPrefix: "glm-tool",
        });
        messages.push(
          ...results.map(({ call, output }) => ({
            role: "tool" as const,
            tool_call_id: call.id,
            content: output,
          })),
        );
        round += 1;
      }
    },
  };
}
