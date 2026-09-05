import type { AgentProvider, AgentRunSink } from "./types.js";
import { codexAuthFile, readCodexAuth } from "./codex-auth.js";
import {
  CODEX_RESPONSES_URL,
  consumeResponsesStream,
  functionCallOutputItem,
  responsesRequestBody,
  userMessage,
} from "./codex-responses.js";
import { glmTurnPolicy } from "./glm-turn-policy.js";
import { createParallelSearch } from "./parallel-search.js";
import { environmentPrompt } from "./prompt.js";
import { agentToolbelt, runToolCalls } from "./toolbelt.js";

/** Total context window for the GPT-5.6 codex models, in tokens. */
const CODEX_CONTEXT_WINDOW = 272_000;

type CodexProviderConfig = Readonly<{
  /** Directory holding the codex CLI's auth.json (defaults to ~/.codex). */
  authDirectory?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}>;

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

/**
 * The codex provider talks directly to the ChatGPT-subscription Responses API
 * (the same endpoint the codex CLI uses) and runs hyos's own tool loop, so it
 * behaves like the GLM provider: hyos tools, hyos patch activities, and no
 * server-side session (context restoration is handled by the host).
 */
export function createCodexProvider(
  config: CodexProviderConfig = {},
): AgentProvider {
  const authFile = codexAuthFile(config.authDirectory);
  const endpoint = (config.baseUrl ?? CODEX_RESPONSES_URL).replace(/\/$/, "");
  const request = config.fetch ?? fetch;
  const search = createParallelSearch({ fetch: config.fetch });

  return {
    summary: {
      id: "codex",
      label: "Codex",
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
        { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      ],
    },
    async prepare() {
      await readCodexAuth(authFile);
    },
    async run(input, sink: AgentRunSink, signal) {
      const auth = await readCodexAuth(authFile);
      const policy = glmTurnPolicy(
        input,
        environmentPrompt(input.folder, input.modelId),
      );
      const { offered, byName } = agentToolbelt(input, search);
      const inputItems: unknown[] = [userMessage(policy.prompt)];
      let round = 0;
      while (true) {
        if (signal.aborted) throw new Error("Cancelled");
        const response = await request(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${auth.accessToken}`,
            "chatgpt-account-id": auth.accountId,
            "content-type": "application/json",
            accept: "text/event-stream",
            originator: "codex_cli_rs",
            "OpenAI-Beta": "responses=experimental",
          },
          body: JSON.stringify(
            responsesRequestBody({
              model: input.modelId,
              instructions: policy.systemPrompt,
              input: inputItems,
              tools: offered,
              effort: policy.effort,
            }),
          ),
          signal,
        });
        if (!response.ok) {
          const loginHint =
            response.status === 401
              ? " (run `codex login` to refresh your ChatGPT sign-in)"
              : "";
          throw new Error(
            `Codex request failed: ${await errorText(response)}${loginHint}`,
          );
        }

        const streamed = await consumeResponsesStream(response, {
          activity: sink.activity,
        });
        const usage = streamed.usage
          ? {
              promptTokens: streamed.usage.inputTokens,
              completionTokens: streamed.usage.outputTokens,
              contextWindow: CODEX_CONTEXT_WINDOW,
            }
          : null;
        if (usage) await sink.usage?.(usage);

        if (streamed.functionCalls.length === 0) {
          if (streamed.text) await sink.response(streamed.text);
          return { providerSessionId: null, ...(usage ? { usage } : {}) };
        }
        if (streamed.text.trim()) {
          await sink.activity(
            `codex-commentary:${round}`,
            { type: "commentary", text: streamed.text },
            "complete",
          );
        }

        const executions = await runToolCalls({
          folder: input.folder,
          intent: input.intent,
          toolsByName: byName,
          calls: streamed.functionCalls.map((call) => ({
            id: call.callId,
            name: call.name,
            arguments: call.arguments,
          })),
          signal,
          activity: sink.activity,
          itemIdPrefix: "codex-tool",
        });
        // Replay the backend's completed items verbatim (they carry the
        // encrypted reasoning state) plus the tool outputs.
        inputItems.push(
          ...streamed.items,
          ...executions.map(({ call, output }) =>
            functionCallOutputItem(call.id, output),
          ),
        );
        round += 1;
      }
    },
  };
}
