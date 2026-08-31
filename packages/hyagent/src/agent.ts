import { randomUUID } from "node:crypto";

import {
  ACTIVITY_MESSAGE_PREFIX,
  encodeActivityEvent,
  type AgentActivityEvent,
} from "./activity.js";
import { DEFAULT_AGENT } from "./agent-options.js";
import { documentOperationsSchema, editLiterateDiff } from "./document.js";
import type { LiterateDiff } from "./domain.js";
import type { GatewayMessage, GatewayTransport } from "./gateway.js";
import type { ProjectTools, WorktreeWarning } from "./project-tools.js";
import type { HyagentStore } from "./store.js";
import type { AgentWebTools } from "./web-tools.js";

function tool(name: string, description: string, parameters: object) {
  return { type: "function", function: { name, description, parameters } };
}

const blockSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { const: "prose" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["id", "kind", "title", "body"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { const: "diagram" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["id", "kind", "title", "body"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { const: "apply_patch" },
        repository: { type: "string" },
        title: { type: "string" },
        rationale: { type: "string" },
        patch: { type: "string" },
      },
      required: ["id", "kind", "repository", "title", "rationale", "patch"],
      additionalProperties: false,
    },
  ],
};

function agentTools(repositories: readonly string[], webEnabled: boolean) {
  const repository = { type: "string", enum: repositories };
  const operation = {
    oneOf: [
      {
        type: "object",
        properties: {
          type: { const: "set_summary" },
          summary: { type: "string" },
        },
        required: ["type", "summary"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { const: "insert_block" },
          after: { type: ["string", "null"] },
          block: blockSchema,
        },
        required: ["type", "block"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { const: "replace_block" },
          id: { type: "string" },
          block: blockSchema,
        },
        required: ["type", "id", "block"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { const: "move_block" },
          id: { type: "string" },
          after: { type: ["string", "null"] },
        },
        required: ["type", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { const: "remove_block" },
          id: { type: "string" },
        },
        required: ["type", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { const: "set_generated_ignores" },
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                repository,
                path: { type: "string" },
                reason: { type: "string" },
              },
              required: ["repository", "path", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["type", "entries"],
        additionalProperties: false,
      },
    ],
  };

  return [
    tool("read_file", "Read a UTF-8 file in a repository's current worktree", {
      type: "object",
      properties: { repository, path: { type: "string" } },
      required: ["repository", "path"],
      additionalProperties: false,
    }),
    tool("run_command", "Run a bounded command in the current worktree", {
      type: "object",
      properties: {
        repository,
        command: { type: "string", enum: ["rg", "git", "npm"] },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["repository", "command", "args"],
      additionalProperties: false,
    }),
    tool(
      "read_literate_diff",
      "Read the authoritative current literate diff and revision number",
      {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    ),
    tool(
      "edit_literate_diff",
      "Edit the live review document. Patch steps after the applied cursor remain unapplied until replayed.",
      {
        type: "object",
        properties: {
          operations: { type: "array", minItems: 1, items: operation },
        },
        required: ["operations"],
        additionalProperties: false,
      },
    ),
    tool(
      "rewind_literate_diff",
      "Move the worktree backward to the state immediately after a patch step. Use null for the state before the first patch.",
      {
        type: "object",
        properties: { to_step_id: { type: ["string", "null"] } },
        required: ["to_step_id"],
        additionalProperties: false,
      },
    ),
    tool(
      "replay_literate_diff",
      "Apply pending patch steps in document order. Omit through_step_id to replay through the final patch.",
      {
        type: "object",
        properties: { through_step_id: { type: "string" } },
        additionalProperties: false,
      },
    ),
    tool(
      "finish_run",
      "Finish the run with an honest outcome. Changed work must be fully replayed before finishing.",
      {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            enum: ["changed", "conversation", "blocked"],
          },
          message: { type: "string" },
        },
        required: ["outcome", "message"],
        additionalProperties: false,
      },
    ),
    ...(webEnabled
      ? [
          tool(
            "web_search",
            "Search the public web and return relevant URLs with focused excerpts.",
            {
              type: "object",
              properties: {
                objective: {
                  type: "string",
                  description:
                    "A self-contained description of the question the search should answer.",
                },
                search_queries: {
                  type: "array",
                  minItems: 1,
                  maxItems: 3,
                  items: { type: "string" },
                  description:
                    "Concise keyword queries, ideally 3-6 words each.",
                },
              },
              required: ["objective", "search_queries"],
              additionalProperties: false,
            },
          ),
          tool(
            "web_fetch",
            "Fetch one or more public URLs as clean Markdown, optionally focused on an objective.",
            {
              type: "object",
              properties: {
                urls: {
                  type: "array",
                  minItems: 1,
                  maxItems: 10,
                  items: { type: "string", format: "uri" },
                },
                objective: {
                  type: "string",
                  description:
                    "What to extract from the pages. Omit to fetch full page content.",
                },
              },
              required: ["urls"],
              additionalProperties: false,
            },
          ),
        ]
      : []),
  ];
}

function systemPrompt(
  repositories: readonly string[],
  webEnabled: boolean,
): string {
  return `You are hyagent. Your product is a live literate diff, not a hidden implementation followed by a summary.

Repositories: ${repositories.join(", ")}.

You may reply conversationally without creating or editing the literate diff when the user is discussing the task, asking a question, or clarifying the approach. Once you begin implementation, use edit_literate_diff early to write a high-level overview, then keep the document current as you investigate and work. A good document reads as ordinary technical prose with explanations next to the patches they justify. It is the final review artifact, not an append-only activity log: replace or remove probes, temporary scripts, failed approaches, duplicate file creations, and obsolete explanations as soon as they stop contributing to the final change. Use diagrams only when they clarify a real relationship.

Before using read_file or run_command, start the literate diff with a high-level overview. Repository work must remain visible in the document as it happens; do not investigate the repository invisibly and write the document afterward.

Apply-patch blocks are ordered executable steps with stable ids. The literate diff has a persisted appliedThrough cursor. The worktree equals the document immediately after that patch step; every later patch remains visible but unapplied. Adding or editing an unapplied patch changes only the document.

Rewind and replay deterministically materialize a document state: Hyagent restores the session's original baseline, then applies patch steps forward from the beginning through the requested step id. This does not depend on the current worktree or on reverse-applying patches. If any step fails, materialization stops before that step and leaves the cursor at the last successful step. Edit or remove the failed and later steps by stable id, then continue replaying.

To revise an applied patch, call rewind_literate_diff with the id of the patch immediately before it, or null when revising the first patch. Future steps stay in the document but become unapplied. Edit the target or later steps, then call replay_literate_diff through one step, a group, or the end. Read_literate_diff returns the cursor and pending step ids. A failed rewind or replay is normal: repair the reported first failing step and continue. There is no recovery mode or re-anchor operation. Do not simulate this workflow with Git commands or use another editing mechanism.

Run search, tests, builds, formatters, and generators with run_command. If a command changes the worktree outside the literate diff, you will receive a WORKTREE_INCONSISTENT warning. Incorporate each meaningful change into a patch or list a genuinely generated path with a reason using set_generated_ignores. Never ignore an implementation or test file, and never ignore a path controlled by a patch block.

${webEnabled ? "Use web_search when current or external information would help, then web_fetch to inspect the most relevant sources in depth. Cite source URLs in conversational answers and in the literate diff when web research informs a decision.\n\n" : ""}Finish every run with finish_run. Outcome=changed is accepted only after a document or cursor change and only when every patch step is applied.`;
}

function warningText(warnings: readonly WorktreeWarning[]): string {
  return [
    "WORKTREE_INCONSISTENT: these changes are not represented in the literate diff:",
    ...warnings.map((warning) => `- ${warning.message}`),
    "Incorporate them into patch blocks or explicitly list generated paths at the bottom of the document.",
  ].join("\n");
}

function documentFromSnapshot(
  revision: Awaited<ReturnType<HyagentStore["getSession"]>>["revision"],
): LiterateDiff | null {
  if (!revision) return null;
  return {
    summary: revision.summary,
    blocks: [...revision.blocks],
    generatedIgnores: [...revision.generatedIgnores],
  };
}

function patchStepIds(document: LiterateDiff | null): string[] {
  return (document?.blocks ?? [])
    .filter((block) => block.kind === "apply_patch")
    .map((block) => block.id);
}

function pendingPatchStepIds(
  document: LiterateDiff | null,
  appliedThrough: string | null,
): string[] {
  const steps = patchStepIds(document);
  if (appliedThrough === null) return steps;
  const index = steps.indexOf(appliedThrough);
  return index < 0 ? steps : steps.slice(index + 1);
}

function toolActivity(name: string, args: Record<string, unknown>): string {
  if (name === "read_file") {
    return `Reading ${String(args.repository)}:${String(args.path)}`;
  }
  if (name === "run_command") {
    const command = [
      args.command,
      ...(Array.isArray(args.args) ? args.args : []),
    ]
      .filter((part): part is string => typeof part === "string")
      .join(" ");
    return `Running ${command.slice(0, 140)}`;
  }
  if (name === "read_literate_diff") return "Reading the literate diff";
  if (name === "edit_literate_diff") return "Updating the literate diff";
  if (name === "rewind_literate_diff") return "Rewinding the literate diff";
  if (name === "replay_literate_diff") return "Replaying the literate diff";
  if (name === "finish_run") return "Finishing the run";
  if (name === "web_search") return "Searching the web";
  if (name === "web_fetch") return "Reading web sources";
  return `Using ${name}`;
}

function toolFailureDetail(
  name: string,
  args: Record<string, unknown>,
  error: string,
): string {
  const detail =
    name === "edit_literate_diff" && Array.isArray(args.operations)
      ? {
          operations: args.operations.map((value) => {
            const operation = value as Record<string, unknown>;
            const block = operation.block as
              Record<string, unknown> | undefined;
            return {
              type: operation.type,
              id: operation.id,
              blockId: block?.id,
            };
          }),
          error,
        }
      : { tool: name, error };
  return JSON.stringify(detail).slice(0, 8_000);
}

export interface LiterateAgent {
  run(
    sessionId: string,
    feedback: string,
    agent?: string,
    signal?: AbortSignal,
  ): Promise<LiterateDiff | null>;
  writeCommitMessages(document: LiterateDiff): Promise<Record<string, string>>;
}

function cleanCommitMessage(content: string | null): string {
  const message = (content ?? "")
    .trim()
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!message) throw new Error("The agent returned an empty commit message");
  return message;
}

export function createLiterateAgent(options: {
  store: HyagentStore;
  project: ProjectTools;
  gateway: GatewayTransport;
  web?: AgentWebTools;
  model?: string;
}): LiterateAgent {
  const model = options.model ?? DEFAULT_AGENT;
  return {
    async writeCommitMessages(document) {
      const repositories = [
        ...new Set(
          document.blocks
            .filter((block) => block.kind === "apply_patch")
            .map((block) => block.repository),
        ),
      ];
      const entries = await Promise.all(
        repositories.map(async (repository) => {
          const changes = document.blocks
            .filter(
              (
                block,
              ): block is Extract<
                LiterateDiff["blocks"][number],
                { kind: "apply_patch" }
              > =>
                block.kind === "apply_patch" && block.repository === repository,
            )
            .map((block) => ({
              title: block.title,
              rationale: block.rationale,
              patch: block.patch,
            }));
          const response = await options.gateway.complete({
            model,
            stream: false,
            messages: [
              {
                role: "system",
                content:
                  "Write a Git commit message for the supplied changes. Return only the commit message: an imperative subject of at most 72 characters, then an optional blank line and concise body explaining why.",
              },
              {
                role: "user",
                content: JSON.stringify({
                  repository,
                  documentSummary: document.summary,
                  changes,
                }).slice(0, 60_000),
              },
            ],
          });
          return [repository, cleanCommitMessage(response.content)] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
    async run(sessionId, feedback, selectedAgent = model, signal) {
      const runId = randomUUID();
      let document: LiterateDiff | null = null;
      const activity = (
        status: AgentActivityEvent["status"],
        summary: string,
        detail?: string,
      ) =>
        options.store.appendMessage(
          sessionId,
          "system",
          encodeActivityEvent({ runId, status, summary, detail }),
        );
      await options.store.appendMessage(sessionId, "user", feedback);
      await options.store.setStatus(sessionId, "running");
      await activity("working", "Preparing the workspace");

      try {
        signal?.throwIfAborted();
        await options.project.initialize();
        signal?.throwIfAborted();
        const repositories = options.project.repositoryNames();
        const tools = agentTools(repositories, Boolean(options.web));
        const snapshot = await options.store.getSession(sessionId);
        document = documentFromSnapshot(snapshot.revision);
        let appliedThrough = snapshot.appliedThrough;
        const initialRevisionNumber = snapshot.revision?.number ?? 0;
        let savedRevisions = 0;
        let cursorChanges = 0;
        const initialWarnings = await options.project.checkConsistency(
          document?.generatedIgnores ?? [],
        );
        const messages: GatewayMessage[] = [
          {
            role: "system",
            content: systemPrompt(repositories, Boolean(options.web)),
          },
          ...snapshot.messages
            .filter(
              (message) =>
                !message.content.startsWith("WORKTREE_INCONSISTENT:") &&
                !message.content.startsWith(ACTIVITY_MESSAGE_PREFIX),
            )
            .map((message) => ({
              role:
                message.role === "agent"
                  ? ("assistant" as const)
                  : ("user" as const),
              content: message.content,
            })),
          {
            role: "user",
            content: `Current literate diff:\n${JSON.stringify(document, null, 2)}\n\nApplied through: ${appliedThrough ?? "before the first patch"}\nPending patch steps: ${pendingPatchStepIds(document, appliedThrough).join(", ") || "none"}${
              initialWarnings.length > 0
                ? `\n\n${warningText(initialWarnings)}`
                : ""
            }`,
          },
        ];
        const persistedWarnings = new Set<string>();

        for (let step = 0; ; step += 1) {
          signal?.throwIfAborted();
          if (step === 0) {
            await activity("working", "Planning the first pass");
          }
          const response = await options.gateway.complete({
            model: selectedAgent,
            messages,
            tools,
            tool_choice: "auto",
            stream: false,
            signal,
          });
          signal?.throwIfAborted();
          messages.push(response);
          const calls = response.tool_calls ?? [];
          if (calls.length === 0) {
            messages.push({
              role: "user",
              content:
                "You must finish with finish_run. Do not claim changed work unless it was saved and every patch step was replayed.",
            });
            continue;
          }

          let finish:
            | {
                outcome: "changed" | "conversation" | "blocked";
                message: string;
              }
            | undefined;
          for (const call of calls) {
            signal?.throwIfAborted();
            let output: unknown;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(call.function.arguments) as Record<
                string,
                unknown
              >;
              await activity("working", toolActivity(call.function.name, args));
              if (
                !document &&
                (call.function.name === "read_file" ||
                  call.function.name === "run_command")
              ) {
                throw new Error(
                  "Start the literate diff with a high-level overview before using repository tools",
                );
              }
              if (
                call.function.name === "read_file" &&
                typeof args.repository === "string" &&
                typeof args.path === "string"
              ) {
                output = await options.project.readFile(
                  args.repository,
                  args.path,
                );
              } else if (
                call.function.name === "run_command" &&
                typeof args.repository === "string" &&
                typeof args.command === "string" &&
                Array.isArray(args.args) &&
                args.args.every((arg) => typeof arg === "string")
              ) {
                output = await options.project.runCommand(
                  args.repository,
                  args.command,
                  args.args,
                  signal,
                );
              } else if (call.function.name === "read_literate_diff") {
                output = {
                  revision: initialRevisionNumber + savedRevisions,
                  document,
                  appliedThrough,
                  pendingStepIds: pendingPatchStepIds(document, appliedThrough),
                };
              } else if (
                call.function.name === "edit_literate_diff" &&
                Array.isArray(args.operations)
              ) {
                const operations = documentOperationsSchema.parse(
                  args.operations,
                );
                const next = editLiterateDiff(document, operations);
                await options.project.validateDocumentEdit(
                  document,
                  next,
                  appliedThrough,
                );
                document = await options.project.enrichDocument(next);
                await options.store.saveRevision(
                  sessionId,
                  document,
                  appliedThrough,
                );
                savedRevisions += 1;
                output = {
                  ok: true,
                  revision: initialRevisionNumber + savedRevisions,
                  summary: document.summary,
                  blocks: document.blocks.map((block) => block.id),
                  appliedThrough,
                  pendingStepIds: pendingPatchStepIds(document, appliedThrough),
                };
              } else if (
                call.function.name === "rewind_literate_diff" &&
                document &&
                (typeof args.to_step_id === "string" ||
                  args.to_step_id === null)
              ) {
                const before = appliedThrough;
                const result = await options.project.movePatchCursor(
                  document,
                  appliedThrough,
                  args.to_step_id,
                );
                appliedThrough = result.appliedThrough;
                await options.store.setAppliedThrough(
                  sessionId,
                  appliedThrough,
                );
                if (before !== appliedThrough) cursorChanges += 1;
                if (result.failed) {
                  await activity(
                    "working",
                    "Rewinding the literate diff failed",
                    JSON.stringify(result.failed).slice(0, 8_000),
                  );
                }
                output = result.failed
                  ? {
                      error: result.failed.error,
                      failedStepId: result.failed.stepId,
                      appliedThrough,
                    }
                  : {
                      ok: true,
                      appliedThrough,
                      pendingStepIds: pendingPatchStepIds(
                        document,
                        appliedThrough,
                      ),
                    };
              } else if (
                call.function.name === "replay_literate_diff" &&
                document &&
                (args.through_step_id === undefined ||
                  typeof args.through_step_id === "string")
              ) {
                const steps = patchStepIds(document);
                const target =
                  typeof args.through_step_id === "string"
                    ? args.through_step_id
                    : (steps.at(-1) ?? null);
                const before = appliedThrough;
                const result = await options.project.movePatchCursor(
                  document,
                  appliedThrough,
                  target,
                );
                appliedThrough = result.appliedThrough;
                await options.store.setAppliedThrough(
                  sessionId,
                  appliedThrough,
                );
                if (before !== appliedThrough) cursorChanges += 1;
                if (result.failed) {
                  await activity(
                    "working",
                    "Replaying the literate diff failed",
                    JSON.stringify(result.failed).slice(0, 8_000),
                  );
                }
                output = result.failed
                  ? {
                      error: result.failed.error,
                      failedStepId: result.failed.stepId,
                      appliedThrough,
                    }
                  : {
                      ok: true,
                      appliedThrough,
                      pendingStepIds: pendingPatchStepIds(
                        document,
                        appliedThrough,
                      ),
                    };
              } else if (
                call.function.name === "finish_run" &&
                ["changed", "conversation", "blocked"].includes(
                  String(args.outcome),
                ) &&
                typeof args.message === "string" &&
                args.message.trim()
              ) {
                if (calls.length !== 1) {
                  throw new Error("finish_run must be called by itself");
                }
                const outcome = args.outcome as
                  "changed" | "conversation" | "blocked";
                if (
                  outcome === "changed" &&
                  savedRevisions === 0 &&
                  cursorChanges === 0
                ) {
                  throw new Error(
                    "Cannot finish with outcome=changed because neither the document nor its applied cursor changed during this run",
                  );
                }
                const pending = pendingPatchStepIds(document, appliedThrough);
                if (outcome === "changed" && pending.length > 0) {
                  throw new Error(
                    `Cannot finish changed work while patch steps remain unapplied: ${pending.join(", ")}`,
                  );
                }
                if (
                  outcome === "conversation" &&
                  (savedRevisions > 0 || cursorChanges > 0)
                ) {
                  throw new Error(
                    "The literate diff or its applied cursor changed during this run; finish with outcome=changed or outcome=blocked",
                  );
                }
                finish = { outcome, message: args.message.trim() };
                output = {
                  ok: true,
                  outcome,
                  revision: initialRevisionNumber + savedRevisions,
                };
              } else if (
                call.function.name === "web_search" &&
                options.web &&
                typeof args.objective === "string" &&
                Array.isArray(args.search_queries) &&
                args.search_queries.every((query) => typeof query === "string")
              ) {
                output = await options.web.search(
                  {
                    objective: args.objective,
                    searchQueries: args.search_queries,
                  },
                  runId,
                  signal,
                );
              } else if (
                call.function.name === "web_fetch" &&
                options.web &&
                Array.isArray(args.urls) &&
                args.urls.every((url) => typeof url === "string") &&
                (args.objective === undefined ||
                  typeof args.objective === "string")
              ) {
                output = await options.web.fetch(
                  {
                    urls: args.urls,
                    ...(typeof args.objective === "string"
                      ? { objective: args.objective }
                      : {}),
                  },
                  runId,
                  signal,
                );
              } else {
                throw new Error("Invalid or unknown tool call");
              }

              signal?.throwIfAborted();
              const warnings = await options.project.checkConsistency(
                document?.generatedIgnores ?? [],
              );
              if (warnings.length > 0) {
                const warning = warningText(warnings);
                output = { error: warning, result: output };
                if (!persistedWarnings.has(warning)) {
                  persistedWarnings.add(warning);
                  await options.store.appendMessage(
                    sessionId,
                    "system",
                    warning,
                  );
                }
              }
            } catch (error) {
              if (signal?.aborted) throw signal.reason;
              const message =
                error instanceof Error ? error.message : String(error);
              await activity(
                "working",
                `${toolActivity(call.function.name, args)} failed`,
                toolFailureDetail(call.function.name, args, message),
              );
              output = {
                error: message,
              };
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content:
                typeof output === "string" ? output : JSON.stringify(output),
            });
          }
          if (finish) {
            await options.store.setStatus(sessionId, "ready");
            await activity(
              "complete",
              finish.outcome === "changed"
                ? "Work complete"
                : finish.outcome === "blocked"
                  ? "Work blocked"
                  : "Response complete",
            );
            await options.store.appendMessage(
              sessionId,
              "agent",
              finish.message,
            );
            return document;
          }
        }
      } catch (error) {
        if (signal?.aborted) {
          await options.store.setStatus(sessionId, "ready");
          await activity("stopped", "Stopped by user");
          return document;
        }
        await options.store.setStatus(sessionId, "failed");
        const message = error instanceof Error ? error.message : String(error);
        await activity("failed", `Run stopped: ${message.slice(0, 300)}`);
        throw error;
      }
    },
  };
}
