import path from "node:path";
import { readFile } from "node:fs/promises";

import type { AgentActivity } from "../../../capabilities/agent.js";
import {
  defaultCdpEndpoint,
  parseCdpEndpoint,
} from "../../../capabilities/browser.js";
import { contentDiff, createPatchActivity } from "./patches.js";
import {
  openCodeTool,
  openCodeTools,
  type OpenCodeTool,
} from "./opencode-tools.js";
import type { AgentRunInput, AgentRunSink } from "./types.js";

/** Read a workspace file's content, or "" when it does not exist yet. */
export async function readWorkspaceFile(
  folder: string,
  requestedPath: string,
): Promise<string> {
  try {
    return await readFile(path.resolve(folder, requestedPath), "utf8");
  } catch {
    return "";
  }
}

/** Human-facing activity describing one tool call or its result. */
export function toolActivity(toolName: string, detail: string): AgentActivity {
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
  if (toolName === "browser_open_tab")
    return {
      type: "tool",
      category: "command",
      label: "Opened browser tab",
      detail,
    };
  if (toolName === "browser_inspect_cdp")
    return {
      type: "tool",
      category: "command",
      label: "Inspected CDP endpoint",
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

function sessionTranscriptTool(input: AgentRunInput): OpenCodeTool {
  return {
    name: "session_transcript",
    description:
      'Read the full transcript of one earlier turn of this agent session — full thinking, tool responses, and patches, beyond the trimmed view in the persisted transcript. Pass the turn id from the <turn id="..."> tag in the persisted transcript. The current turn\'s detail is not available.',
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
  };
}

function browserOpenTabTool(input: AgentRunInput): OpenCodeTool | null {
  if (!input.browserClient) return null;
  return {
    name: "browser_open_tab",
    description:
      "Open a new browser tab with the specified URL. Use this to view web pages or documentation.",
    category: "command",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to open in the new browser tab",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(_folder, args) {
      const url = typeof args.url === "string" ? args.url : "";
      if (!url) throw new Error("url is required");
      const state = await input.browserClient!.execute({
        type: "create-tab",
        url,
      });
      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
      const title = activeTab?.title || url;
      // Record the opened page in the session's persisted strip so a
      // subscribing renderer shows it without diffing host publishes.
      // The record persists {tabId, url}; create-tab activates the new tab,
      // so the active tab is the one to name. Background pane state: a
      // failed or unidentifiable write never fails the tool call.
      if (input.appendSessionTab && activeTab) {
        try {
          await input.appendSessionTab({
            kind: "browser",
            tabId: activeTab.id,
            url,
          });
        } catch {
          // Ignore — the strip converges on the next write.
        }
      }
      return {
        output: `Opened browser tab: ${activeTab?.title || url} (${url})`,
      };
    },
  };
}

function browserInspectCdpTool(input: AgentRunInput): OpenCodeTool | null {
  if (!input.browserClient) return null;
  return {
    name: "browser_inspect_cdp",
    description:
      "Inspect a Chrome DevTools Protocol endpoint (default localhost:9333) to list its debug targets, or open one target's DevTools frontend as a side pane tab. Pass targetId to open; omit it to list.",
    category: "command",
    parameters: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description:
            "CDP endpoint as host:port or http://host:port (default localhost:9333)",
        },
        targetId: {
          type: "string",
          description:
            "Target id to open its DevTools frontend for; omit to only list targets",
        },
      },
      additionalProperties: false,
    },
    async execute(_folder, args) {
      const endpointText =
        typeof args.endpoint === "string" ? args.endpoint : "";
      const endpoint = endpointText
        ? parseCdpEndpoint(endpointText)
        : defaultCdpEndpoint;
      if (!endpoint) throw new Error(`Invalid CDP endpoint: ${endpointText}`);
      const client = input.browserClient!;
      if (typeof args.targetId === "string" && args.targetId) {
        const opened = await client.openCdpTarget({
          endpoint,
          targetId: args.targetId,
        });
        const frontend = opened.target.devtoolsFrontendUrl ?? "";
        if (input.appendSessionTab && frontend) {
          try {
            await input.appendSessionTab({
              kind: "browser",
              tabId: opened.tabId,
              url: frontend,
            });
          } catch {
            // Ignore — the strip converges on the next write.
          }
        }
        return {
          output: `Opened DevTools for "${opened.target.title || opened.target.id}" (${opened.target.url}) as tab ${opened.tabId}`,
        };
      }
      const targets = await client.inspectCdp(endpoint);
      if (targets.length === 0)
        return {
          output: `No debug targets on ${endpoint.host}:${endpoint.port}`,
        };
      const lines = targets.map(
        (target) =>
          `${target.id} [${target.type}] ${target.title || "(untitled)"} — ${target.url}`,
      );
      return {
        output:
          `Targets on ${endpoint.host}:${endpoint.port}:\n` + lines.join("\n"),
      };
    },
  };
}

/**
 * The tools a model may call in a run: the OpenCode toolset, parallel web
 * search, and — when the host can serve transcripts — the session transcript
 * reader. Edit tools are withheld from `offered` on investigate-only turns;
 * `byName` keeps every executable tool so lookups still work (the executor
 * blocks edit categories itself).
 */
export function agentToolbelt(
  input: AgentRunInput,
  search: OpenCodeTool,
): Readonly<{
  offered: readonly OpenCodeTool[];
  byName: ReadonlyMap<string, OpenCodeTool>;
}> {
  const all = [...openCodeTools, search];
  // Summary turns (interrupt follow-ups) must make no tool calls at all:
  // nothing is offered to the model, so it can only reply in prose.
  if (input.intent === "summary") return { offered: [], byName: new Map() };
  const offeredBase =
    input.intent === "investigate"
      ? all.filter((tool) => tool.category !== "edit")
      : all;
  const transcriptTool = input.sessionTranscript
    ? sessionTranscriptTool(input)
    : null;
  const browserTool = browserOpenTabTool(input);
  const cdpTool = browserInspectCdpTool(input);
  const extraTools = [transcriptTool, browserTool, cdpTool].filter(
    (tool): tool is OpenCodeTool => tool !== null,
  );
  return {
    offered:
      extraTools.length > 0 ? [...offeredBase, ...extraTools] : offeredBase,
    byName: new Map([...all, ...extraTools].map((tool) => [tool.name, tool])),
  };
}

/** One executed tool call: the request plus the result text fed to the model. */
export type ToolExecution = Readonly<{
  call: Readonly<{ id: string; name: string; arguments: string }>;
  output: string;
}>;

/**
 * Execute a round of model-requested tool calls: parse arguments, block edit
 * tools on investigate-only turns, capture before/after content for patch
 * activities, and map failures to tool results. Shared by the GLM and codex
 * providers, which map `output` into their own wire formats.
 */
/**
 * Serialize edit-category executions per resolved file path with a
 * promise-chain mutex: parallel tool calls to the same file run one at a time
 * so read-modify-write edits cannot clobber each other.
 */
const editLocks = new Map<string, Promise<void>>();

function withPathLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = editLocks.get(key) ?? Promise.resolve();
  const guarded = previous.catch(() => {}).then(run);
  const release = guarded
    .then(
      () => {},
      () => {},
    )
    .then(() => {
      if (editLocks.get(key) === release) editLocks.delete(key);
    });
  editLocks.set(key, release);
  return guarded;
}

export async function runToolCalls(options: {
  folder: string;
  intent?: "implement" | "investigate" | "summary";
  toolsByName: ReadonlyMap<string, OpenCodeTool>;
  calls: readonly Readonly<{
    id: string;
    name: string;
    arguments: string;
  }>[];
  signal: AbortSignal;
  activity: AgentRunSink["activity"];
  /** Provider-scoped prefix for activity item ids, e.g. "glm-tool". */
  itemIdPrefix: string;
}): Promise<readonly ToolExecution[]> {
  return Promise.all(
    options.calls.map(async (call) => {
      const providerItemId = `${options.itemIdPrefix}:${call.id}`;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch (error) {
        const message = `Invalid ${call.name} arguments: ${error instanceof Error ? error.message : String(error)}`;
        await options.activity(
          providerItemId,
          toolActivity(call.name, call.arguments),
          "failed",
        );
        return { call, output: message };
      }
      await options.activity(
        providerItemId,
        toolActivity(call.name, JSON.stringify(args, null, 2)),
        "streaming",
      );
      try {
        if (options.intent === "summary") {
          // Belt-and-suspenders: a summary turn offers no tools, so any call
          // attempt is refused without executing anything.
          await options.activity(
            providerItemId,
            toolActivity(call.name, JSON.stringify(args, null, 2)),
            "failed",
          );
          return {
            call,
            output:
              "Blocked: this summary turn cannot make tool calls. Reply in prose only.",
          };
        }
        const tool = options.toolsByName.get(call.name);
        if (!tool) throw new Error(`Unknown tool: ${call.name}`);
        if (options.intent === "investigate" && tool.category === "edit") {
          const message =
            "Blocked: this is an investigate-only turn; edit and write tools are disabled.";
          await options.activity(
            providerItemId,
            toolActivity(call.name, JSON.stringify(args, null, 2)),
            "failed",
          );
          return { call, output: message };
        }
        const editPaths =
          tool.category === "edit" && typeof args.filePath === "string"
            ? [args.filePath]
            : [];
        // Serialize per resolved path and capture the `before` snapshot
        // inside the lock so patch diffs reflect exactly this call's change.
        const runSerialized = async (): Promise<{
          result: Awaited<ReturnType<OpenCodeTool["execute"]>>;
          fallbackDiff: string;
        }> => {
          const serialize = editPaths.length > 0;
          const execute = async () => {
            const before = new Map<string, string>();
            for (const editPath of editPaths) {
              before.set(
                editPath,
                await readWorkspaceFile(options.folder, editPath),
              );
            }
            const result = await tool.execute(
              options.folder,
              args,
              options.signal,
            );
            const fallbackDiff = (
              await Promise.all(
                (tool.category === "edit" && result.paths
                  ? result.paths
                  : []
                ).map(async (editedPath) =>
                  contentDiff(
                    editedPath,
                    before.get(editedPath) ?? "",
                    await readWorkspaceFile(options.folder, editedPath),
                  ),
                ),
              )
            ).join("\n");
            return { result, fallbackDiff };
          };
          return serialize
            ? withPathLock(path.resolve(options.folder, editPaths[0]), execute)
            : execute();
        };
        const { result, fallbackDiff } = await runSerialized();
        if (tool.category === "edit" && result.paths) {
          const explanation =
            typeof args.explanation === "string" ? args.explanation : "";
          await options.activity(
            providerItemId,
            await createPatchActivity({
              folder: options.folder,
              explanation,
              changes: result.paths.map((editedPath) => ({
                path: editedPath,
                kind: call.name === "write" ? "write" : "update",
              })),
              fallbackDiff,
              preferFallbackDiff: true,
            }),
            "complete",
          );
        } else {
          await options.activity(
            providerItemId,
            toolActivity(call.name, result.output),
            "complete",
          );
        }
        return { call, output: result.output || "Success" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await options.activity(
          providerItemId,
          toolActivity(call.name, message),
          "failed",
        );
        return { call, output: `Error: ${message}` };
      }
    }),
  );
}
