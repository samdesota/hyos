import { execFile } from "node:child_process";
import { z } from "zod";

import type {
  AgentActivity,
  AgentToolCategory,
} from "../../../capabilities/agent.js";
import type { AgentProvider, AgentRunSink } from "./types.js";
import { resolveExecutable } from "./executable.js";
import {
  claudePatchChanges,
  claudePatchToolInstruction,
  claudeCompletionInstruction,
  createPatchActivity,
  promptWithPatchContract,
} from "./patches.js";
import {
  editFile,
  editInputSchema,
  writeInputSchema,
  writeWholeFile,
} from "./claude-edit-tools.js";

type ClaudeProviderConfig = Readonly<{
  binaryPath?: string;
  configDirectory?: string;
}>;

type PendingPatch = Readonly<{
  explanation: string;
  changes: ReturnType<typeof claudePatchChanges>;
  fallbackDiff: string;
  preferFallbackDiff?: boolean;
}>;

function claudeEnvironment(config: ClaudeProviderConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(config.configDirectory
      ? { CLAUDE_CONFIG_DIR: config.configDirectory }
      : {}),
    CLAUDE_AGENT_SDK_CLIENT_APP: "hyos/0.0.0",
  };
}

function authStatus(
  binary: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ loggedIn: boolean; authMethod?: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ["auth", "status"],
      { env: environment, timeout: 10_000 },
      (error, stdout, stderr) => {
        try {
          const parsed = JSON.parse(stdout) as {
            loggedIn?: unknown;
            authMethod?: unknown;
          };
          resolve({
            loggedIn: parsed.loggedIn === true,
            authMethod:
              typeof parsed.authMethod === "string"
                ? parsed.authMethod
                : undefined,
          });
        } catch {
          reject(
            new Error(
              error?.message ||
                stderr.trim() ||
                "Claude Code auth check failed.",
            ),
          );
        }
      },
    );
  });
}

export function claudeToolCategory(
  name: string,
  input?: unknown,
): AgentToolCategory {
  if (["mcp__hyos__Edit", "mcp__hyos__Write"].includes(name)) return "edit";
  if (["Read", "Glob", "Grep"].includes(name)) return "read";
  if (["Edit", "Write", "NotebookEdit"].includes(name)) return "edit";
  if (["WebSearch", "WebFetch"].includes(name)) return "search";
  if (["TodoWrite"].includes(name)) return "plan";
  if (name === "Bash") {
    const description =
      input && typeof input === "object"
        ? (input as Record<string, unknown>).description
        : undefined;
    if (
      typeof description === "string" &&
      /^(?:read|inspect|list|show|search|find|check|look)\b/i.test(description)
    ) {
      return "read";
    }
    return "command";
  }
  return "tool";
}

function toolLabel(name: string, category: AgentToolCategory): string {
  if (category === "read") return "Read files";
  if (category === "edit") return "Edited files";
  if (category === "search") return "Searched the web";
  if (category === "plan") return "Updated the plan";
  if (category === "command") return "Ran a command";
  return `Used ${name}`;
}

export function createClaudeProvider(
  config: ClaudeProviderConfig = {},
): AgentProvider {
  const requestedBinary = config.binaryPath ?? "claude";
  let binaryPromise: Promise<string> | undefined;
  const binary = (): Promise<string> => {
    binaryPromise ??= resolveExecutable(requestedBinary).then((resolved) => {
      if (resolved) return resolved;
      throw new Error(
        `Claude Code was not found (${requestedBinary}). Install it and run \`claude auth login\` before using this provider.`,
      );
    });
    return binaryPromise;
  };
  const environment = claudeEnvironment(config);

  return {
    summary: {
      id: "claude",
      label: "Claude",
      models: [
        { id: "sonnet", label: "Claude Sonnet" },
        { id: "opus", label: "Claude Opus" },
        { id: "haiku", label: "Claude Haiku" },
      ],
    },
    async prepare() {
      const status = await authStatus(await binary(), environment);
      if (!status.loggedIn) {
        throw new Error(
          "Claude Code is signed out. Run `claude auth login` to connect your Claude subscription.",
        );
      }
      if (status.authMethod === "apiKey") {
        throw new Error(
          "Claude Code is using an API key, not a Claude subscription. Run `claude auth login` with ANTHROPIC_API_KEY unset.",
        );
      }
    },
    async run(input, sink: AgentRunSink, signal) {
      const { createSdkMcpServer, query, tool } =
        await import("@anthropic-ai/claude-agent-sdk");
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      signal.addEventListener("abort", abort, { once: true });
      let providerSessionId = input.providerSessionId;
      let checkpointedSessionId = input.providerSessionId;
      let pendingText = "";
      let commentaryIndex = 0;
      let thinkingIndex = 0;
      const streamedThinking = new Map<number, { id: string; text: string }>();
      const completedThinking = new Set<string>();
      const tools = new Map<string, AgentActivity>();
      const pendingPatches = new Map<string, PendingPatch>();
      let completionConfirmed = false;
      const patchServer = createSdkMcpServer({
        name: "hyos",
        version: "1.0.0",
        alwaysLoad: true,
        tools: [
          tool(
            "Edit",
            "Replace an exact string in a file. This is Claude Code's Edit interface with a required explanation.",
            editInputSchema,
            (args) => editFile(input.folder, args),
            { alwaysLoad: true },
          ),
          tool(
            "Write",
            "Write complete content to a file. This is Claude Code's Write interface with a required explanation.",
            writeInputSchema,
            (args) => writeWholeFile(input.folder, args),
            { alwaysLoad: true },
          ),
          tool(
            "Complete",
            "Confirm that the entire user request is implemented and verified. Never call this while planned work remains.",
            {
              summary: z.string().trim().min(1),
              verification: z.array(z.string()).optional(),
            },
            async (args) => {
              completionConfirmed = true;
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Completion recorded: ${args.summary}`,
                  },
                ],
              };
            },
            { alwaysLoad: true },
          ),
        ],
      });

      const commitCommentary = async (): Promise<void> => {
        if (!pendingText.trim()) return;
        await sink.activity(
          `commentary:${commentaryIndex++}`,
          { type: "commentary", text: pendingText },
          "complete",
        );
        pendingText = "";
      };

      // A summary turn (interrupt follow-up) must make no tool calls: no
      // built-in tools, no MCP patch server, no patch/completion contract,
      // and exactly one model round.
      const summary = input.intent === "summary";
      let queryPrompt = summary
        ? input.prompt
        : `${promptWithPatchContract(input.prompt)}\n\n${claudePatchToolInstruction}\n\n${claudeCompletionInstruction}`;
      try {
        while (!completionConfirmed) {
          const stream = query({
            prompt: queryPrompt,
            options: {
              abortController,
              cwd: input.folder,
              model: input.modelId,
              resume: providerSessionId ?? undefined,
              includePartialMessages: true,
              thinking: { type: "adaptive", display: "summarized" },
              permissionMode: "acceptEdits",
              tools: summary ? [] : { type: "preset", preset: "claude_code" },
              ...(summary
                ? {}
                : {
                    mcpServers: { hyos: patchServer },
                    toolAliases: {
                      Edit: "mcp__hyos__Edit",
                      Write: "mcp__hyos__Write",
                      Complete: "mcp__hyos__Complete",
                    },
                  }),
              pathToClaudeCodeExecutable: await binary(),
              env: environment,
            },
          });
          try {
            for await (const message of stream) {
              providerSessionId = message.session_id ?? providerSessionId;
              if (
                providerSessionId &&
                providerSessionId !== checkpointedSessionId
              ) {
                await sink.session(providerSessionId);
                checkpointedSessionId = providerSessionId;
              }
              if (
                message.type === "stream_event" &&
                message.parent_tool_use_id === null
              ) {
                const event = message.event;
                if (
                  event.type === "content_block_start" &&
                  event.content_block.type === "thinking"
                ) {
                  const id = `thinking:${thinkingIndex++}`;
                  streamedThinking.set(event.index, {
                    id,
                    text: event.content_block.thinking,
                  });
                  await sink.activity(
                    id,
                    {
                      type: "commentary",
                      text: event.content_block.thinking || "Thinking…",
                    },
                    "streaming",
                  );
                } else if (
                  event.type === "content_block_delta" &&
                  event.delta.type === "thinking_delta"
                ) {
                  const current = streamedThinking.get(event.index) ?? {
                    id: `thinking:${thinkingIndex++}`,
                    text: "",
                  };
                  const text = current.text + event.delta.thinking;
                  streamedThinking.set(event.index, { ...current, text });
                  await sink.activity(
                    current.id,
                    { type: "commentary", text: text || "Thinking…" },
                    "streaming",
                  );
                } else if (event.type === "content_block_stop") {
                  const current = streamedThinking.get(event.index);
                  if (current) {
                    await sink.activity(
                      current.id,
                      {
                        type: "commentary",
                        text: current.text || "Thinking…",
                      },
                      "complete",
                    );
                    if (current.text) completedThinking.add(current.text);
                    streamedThinking.delete(event.index);
                  }
                }
                continue;
              }
              if (
                message.type === "assistant" &&
                message.parent_tool_use_id === null
              ) {
                for (const block of message.message.content) {
                  if (block.type === "text") {
                    pendingText += block.text;
                  } else if (block.type === "thinking") {
                    if (completedThinking.has(block.thinking)) {
                      completedThinking.delete(block.thinking);
                    } else {
                      await sink.activity(
                        `thinking:${thinkingIndex++}`,
                        { type: "commentary", text: block.thinking },
                        "complete",
                      );
                    }
                  } else if (block.type === "tool_use") {
                    const toolInput = block.input as Record<string, unknown>;
                    const explanation =
                      typeof toolInput.explanation === "string"
                        ? toolInput.explanation
                        : pendingText;
                    await commitCommentary();
                    const category = claudeToolCategory(
                      block.name,
                      block.input,
                    );
                    const patch =
                      category === "edit"
                        ? {
                            explanation,
                            changes: claudePatchChanges(
                              block.name,
                              block.input,
                            ),
                            fallbackDiff:
                              typeof toolInput.patch === "string"
                                ? toolInput.patch
                                : "",
                            preferFallbackDiff:
                              typeof toolInput.patch === "string",
                          }
                        : null;
                    if (patch) pendingPatches.set(block.id, patch);
                    let activity: AgentActivity;
                    if (patch) {
                      try {
                        activity = await createPatchActivity({
                          folder: input.folder,
                          ...patch,
                        });
                      } catch (error) {
                        activity = {
                          type: "tool",
                          category: "edit",
                          label: "Patch rejected",
                          detail:
                            error instanceof Error
                              ? error.message
                              : String(error),
                        };
                      }
                    } else {
                      activity = {
                        type: "tool",
                        category,
                        label: toolLabel(block.name, category),
                        detail: JSON.stringify(block.input, null, 2),
                      };
                    }
                    tools.set(block.id, activity);
                    await sink.activity(
                      `${activity.type === "patch" ? "patch" : "tool"}:${block.id}`,
                      activity,
                      "streaming",
                    );
                  }
                }
              } else if (
                message.type === "user" &&
                message.parent_tool_use_id === null &&
                Array.isArray(message.message.content)
              ) {
                for (const block of message.message.content) {
                  if (block.type !== "tool_result") continue;
                  const activity = tools.get(block.tool_use_id);
                  if (!activity) continue;
                  const pendingPatch = pendingPatches.get(block.tool_use_id);
                  const completedActivity =
                    pendingPatch && !block.is_error
                      ? await createPatchActivity({
                          folder: input.folder,
                          ...pendingPatch,
                        })
                      : activity;
                  tools.set(block.tool_use_id, completedActivity);
                  await sink.activity(
                    `${activity.type === "patch" ? "patch" : "tool"}:${block.tool_use_id}`,
                    completedActivity,
                    block.is_error ? "failed" : "complete",
                  );
                  pendingPatches.delete(block.tool_use_id);
                }
              } else if (message.type === "result") {
                if (message.subtype !== "success") {
                  throw new Error(message.errors.join("\n") || message.subtype);
                }
                const finalText = message.result || pendingText;
                pendingText = "";
                if (finalText) await sink.response(finalText);
                if (message.is_error) throw new Error(message.result);
              }
            }
          } finally {
            stream.close();
          }
          if (!completionConfirmed) {
            // A summary round is single-shot: it never calls Complete, so
            // looping would re-prompt forever.
            if (summary) break;
            if (signal.aborted) throw new Error("Cancelled");
            queryPrompt = `You ended the previous turn without calling Complete, so the task is still incomplete. Continue implementing and verifying the original request. Call Complete only when no requested work remains.\n\n${claudePatchToolInstruction}\n\n${claudeCompletionInstruction}`;
          }
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }

      if (pendingText) await sink.response(pendingText);
      return { providerSessionId };
    },
  };
}
