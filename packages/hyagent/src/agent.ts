import { randomUUID } from "node:crypto";

import {
  ACTIVITY_MESSAGE_PREFIX,
  encodeActivityEvent,
  type AgentActivityEvent,
} from "./activity.js";
import { documentOperationsSchema, editLiterateDiff } from "./document.js";
import type { LiterateDiff } from "./domain.js";
import type { GatewayMessage, GatewayTransport } from "./gateway.js";
import type { ProjectTools, WorktreeWarning } from "./project-tools.js";
import type { HyagentStore } from "./store.js";

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

function agentTools(repositories: readonly string[]) {
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
      "edit_literate_diff",
      "Edit the live review document. This is the only way to propose code changes.",
      {
        type: "object",
        properties: {
          operations: { type: "array", minItems: 1, items: operation },
        },
        required: ["operations"],
        additionalProperties: false,
      },
    ),
  ];
}

function systemPrompt(repositories: readonly string[]): string {
  return `You are hyagent. Your product is a live literate diff, not a hidden implementation followed by a summary.

Repositories: ${repositories.join(", ")}.

You may reply conversationally without creating or editing the literate diff when the user is discussing the task, asking a question, or clarifying the approach. Once you begin implementation, use edit_literate_diff early to write a high-level overview, then keep the document current as you investigate and work. A good document reads as ordinary technical prose with explanations next to the patches they justify. Use diagrams only when they clarify a real relationship.

Patches are applied to the selected repository's current worktree as document blocks are added. If revising an earlier patch breaks a later patch, replay stops and the tool returns that failure for you to repair. Never use another editing mechanism.

Run search, tests, builds, formatters, and generators with run_command. If a command changes the worktree outside the literate diff, you will receive a WORKTREE_INCONSISTENT warning. Incorporate each meaningful change into a patch or list a generated path with a reason using set_generated_ignores.

When the work and document are coherent, respond normally without another tool call.`;
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
  if (name === "edit_literate_diff") return "Updating the literate diff";
  return `Using ${name}`;
}

export interface LiterateAgent {
  run(sessionId: string, feedback: string): Promise<LiterateDiff | null>;
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
  model?: string;
  maxSteps?: number;
}): LiterateAgent {
  const model = options.model ?? "anthropic/claude-sonnet-4.5";
  const maxSteps = options.maxSteps ?? 24;
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
    async run(sessionId, feedback) {
      const runId = randomUUID();
      const activity = (
        status: AgentActivityEvent["status"],
        summary: string,
      ) =>
        options.store.appendMessage(
          sessionId,
          "system",
          encodeActivityEvent({ runId, status, summary }),
        );
      await options.store.appendMessage(sessionId, "user", feedback);
      await options.store.setStatus(sessionId, "running");
      await activity("working", "Preparing the workspace");

      try {
        await options.project.initialize();
        const repositories = options.project.repositoryNames();
        const tools = agentTools(repositories);
        const snapshot = await options.store.getSession(sessionId);
        let document = documentFromSnapshot(snapshot.revision);
        const initialWarnings = await options.project.checkConsistency(
          document?.generatedIgnores ?? [],
        );
        const messages: GatewayMessage[] = [
          { role: "system", content: systemPrompt(repositories) },
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
            content: `Current literate diff:\n${JSON.stringify(document, null, 2)}${
              initialWarnings.length > 0
                ? `\n\n${warningText(initialWarnings)}`
                : ""
            }`,
          },
        ];
        const persistedWarnings = new Set<string>();

        for (let step = 0; step < maxSteps; step += 1) {
          await activity(
            "working",
            step === 0 ? "Planning the first pass" : "Reviewing tool results",
          );
          const response = await options.gateway.complete({
            model,
            messages,
            tools,
            tool_choice: "auto",
            stream: false,
          });
          messages.push(response);
          const calls = response.tool_calls ?? [];
          if (calls.length === 0) {
            const reply = response.content?.trim();
            if (!document && !reply)
              throw new Error("Agent returned an empty response");
            await options.store.setStatus(sessionId, "ready");
            await activity(
              "complete",
              document ? "Work complete" : "Response complete",
            );
            await options.store.appendMessage(
              sessionId,
              "agent",
              reply || document!.summary,
            );
            return document;
          }

          for (const call of calls) {
            let output: unknown;
            try {
              const args = JSON.parse(call.function.arguments) as Record<
                string,
                unknown
              >;
              await activity("working", toolActivity(call.function.name, args));
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
                );
              } else if (
                call.function.name === "edit_literate_diff" &&
                Array.isArray(args.operations)
              ) {
                const operations = documentOperationsSchema.parse(
                  args.operations,
                );
                const next = editLiterateDiff(document, operations);
                await options.project.syncPatches(document, next);
                document = await options.project.enrichDocument(next);
                await options.store.saveRevision(sessionId, document);
                output = {
                  ok: true,
                  summary: document.summary,
                  blocks: document.blocks.map((block) => block.id),
                };
              } else {
                throw new Error("Invalid or unknown tool call");
              }

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
              output = {
                error: error instanceof Error ? error.message : String(error),
              };
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content:
                typeof output === "string" ? output : JSON.stringify(output),
            });
          }
        }
        if (document) {
          await options.store.setStatus(sessionId, "ready");
          await activity("complete", "Work complete");
          await options.store.appendMessage(
            sessionId,
            "agent",
            document.summary,
          );
          return document;
        }
        throw new Error(`Agent exceeded ${maxSteps} model steps`);
      } catch (error) {
        await options.store.setStatus(sessionId, "failed");
        const message = error instanceof Error ? error.message : String(error);
        await activity("failed", `Run stopped: ${message.slice(0, 300)}`);
        throw error;
      }
    },
  };
}
