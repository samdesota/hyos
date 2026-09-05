import path from "node:path";
import { readFile } from "node:fs/promises";

import type { AgentActivity } from "../../../capabilities/agent.js";
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
  const offeredBase =
    input.intent === "investigate"
      ? all.filter((tool) => tool.category !== "edit")
      : all;
  const transcriptTool = input.sessionTranscript
    ? sessionTranscriptTool(input)
    : null;
  return {
    offered: transcriptTool ? [...offeredBase, transcriptTool] : offeredBase,
    byName: new Map(
      [...all, ...(transcriptTool ? [transcriptTool] : [])].map((tool) => [
        tool.name,
        tool,
      ]),
    ),
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
export async function runToolCalls(options: {
  folder: string;
  intent?: "implement" | "investigate";
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
        const before = new Map<string, string>();
        for (const editPath of editPaths) {
          before.set(
            editPath,
            await readWorkspaceFile(options.folder, editPath),
          );
        }
        const result = await tool.execute(options.folder, args, options.signal);
        if (tool.category === "edit" && result.paths) {
          const explanation =
            typeof args.explanation === "string" ? args.explanation : "";
          const fallbackDiff = (
            await Promise.all(
              result.paths.map(async (editedPath) =>
                contentDiff(
                  editedPath,
                  before.get(editedPath) ?? "",
                  await readWorkspaceFile(options.folder, editedPath),
                ),
              ),
            )
          ).join("\n");
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
