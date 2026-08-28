import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  ElementSelection,
  AgentActivityReporter,
  QuickIterationAgent,
  QuickIterationRequest,
  QuickIterationResult,
  QuickIterationUndoResult,
  TextReplacement,
} from "./agent-types.js";
import type {
  GatewayMessage,
  GatewayReasoningEffort,
  GatewayTransport,
} from "./gateway.js";
import { createProjectTools } from "./project-tools.js";
import { DEFAULT_UI_AGENT_MODEL } from "./models.js";

const editSchema = z.object({
  path: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
});
const submissionSchema = z.object({
  summary: z.string().min(1),
  edits: z.array(editSchema).min(1).max(12),
});
const inputSchema = z.object({
  instruction: z.string().min(1).max(4_000),
  model: z.string().min(1).max(200).optional(),
  continuationId: z.string().min(1).max(200).optional(),
  selection: z.object({
    tagName: z.string().min(1),
    text: z.string().max(8_000).optional(),
    id: z.string().optional(),
    classNames: z.array(z.string()).max(100).optional(),
    attributes: z.record(z.string(), z.string()).optional(),
    cssPath: z.string().optional(),
    sourceHint: z.string().optional(),
    boundingBox: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional(),
  }),
  contextElements: z
    .array(
      z.object({
        tagName: z.string().min(1),
        text: z.string().max(8_000).optional(),
        id: z.string().optional(),
        classNames: z.array(z.string()).max(100).optional(),
        attributes: z.record(z.string(), z.string()).optional(),
        cssPath: z.string().optional(),
        sourceHint: z.string().optional(),
        boundingBox: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          })
          .optional(),
      }),
    )
    .max(60)
    .optional(),
  screenshot: z
    .object({
      dataUrl: z.string().startsWith("data:image/").max(4_000_000),
      width: z.number().positive().max(4_096),
      height: z.number().positive().max(4_096),
    })
    .optional(),
  mode: z.enum(["preview", "apply"]).optional(),
});

const tools = [
  tool(
    "list_files",
    "List editable project files, optionally filtered by a path fragment",
    {
      type: "object",
      properties: { pattern: { type: "string" } },
    },
  ),
  tool("search_code", "Search project text files for a literal string", {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  }),
  tool("read_file", "Read one project file", {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  }),
  tool(
    "submit_edits",
    "Finish by submitting exact, minimal text replacements",
    {
      type: "object",
      properties: {
        summary: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              find: { type: "string" },
              replace: { type: "string" },
            },
            required: ["path", "find", "replace"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "edits"],
      additionalProperties: false,
    },
  ),
];

function tool(name: string, description: string, parameters: object) {
  return { type: "function", function: { name, description, parameters } };
}

function systemPrompt(): string {
  return `You are a fast UI code iteration agent working inside a development project.
Make the smallest correct code change for the requested visual adjustment.
Use the selected DOM details to locate the implementation.
The initial user message may include likely relevant project files. Treat those files as already inspected.
If the supplied source contains everything needed for the change, call submit_edits immediately as your first and only tool call.
For a localized request, prefer one minimal replacement. Do not call read_file or search_code merely to confirm source already present in the prompt.
Use discovery tools only when the supplied source genuinely lacks code required to make the change safely.
Do not alter generated files, dependencies, lockfiles, or unrelated behavior.
Preserve the project's framework and style conventions.
Every find string must be copied exactly from a file and must uniquely identify the replacement.
You must finish by calling submit_edits. Never claim to have written files yourself.`;
}

export interface CreateQuickIterationAgentOptions {
  projectRoot: string;
  gateway: GatewayTransport;
  model?: string;
  maxSteps?: number;
  reasoning?: GatewayReasoningEffort;
  providerOrder?: string[];
}

export function createQuickIterationAgent(
  options: CreateQuickIterationAgentOptions,
): QuickIterationAgent {
  const project = createProjectTools(options.projectRoot);
  const defaultModel = options.model ?? DEFAULT_UI_AGENT_MODEL;
  const maxSteps = options.maxSteps ?? 10;
  const undoHistory = new Map<
    string,
    Awaited<ReturnType<typeof project.applyEdits>>
  >();
  const conversations = new Map<string, GatewayMessage[]>();

  return {
    async undo(id: string): Promise<QuickIterationUndoResult> {
      const changes = undoHistory.get(id);
      if (!changes)
        throw new Error("This change is no longer available to undo");
      await project.undoEdits(changes);
      undoHistory.delete(id);
      conversations.get(id)?.push({
        role: "system",
        content:
          "The user undid the previous change. The project files were restored to their state before that change.",
      });
      return { id, undone: true };
    },
    async run(
      rawRequest: QuickIterationRequest,
      report: AgentActivityReporter = () => undefined,
    ): Promise<QuickIterationResult> {
      const request = inputSchema.parse(rawRequest);
      const model = request.model ?? defaultModel;
      const contextStartedAt = Date.now();
      report({ phase: "context", message: "Inspecting selected UI context" });
      const selections = [
        request.selection,
        ...(request.contextElements ?? []),
      ];
      const context = await retrieveLikelyContext(project, selections);
      report({
        phase: "context",
        message: "Relevant source context collected",
        detail: `${Date.now() - contextStartedAt}ms`,
      });
      const userPrompt = `${request.continuationId ? "Follow-up instruction" : "Instruction"}:\n${request.instruction}\n\nPrimary selected element:\n${JSON.stringify(request.selection, null, 2)}\n\nOther elements intersecting the selected region:\n${JSON.stringify(request.contextElements ?? [], null, 2)}${context}`;
      const priorMessages = request.continuationId
        ? conversations.get(request.continuationId)
        : undefined;
      if (request.continuationId && !priorMessages) {
        throw new Error("The previous agent state is no longer available");
      }
      const messages: GatewayMessage[] = priorMessages
        ? structuredClone(priorMessages)
        : [{ role: "system", content: systemPrompt() }];
      messages.push({
        role: "user",
        content: request.screenshot
          ? [
              { type: "text", text: userPrompt },
              {
                type: "image_url",
                image_url: {
                  url: request.screenshot.dataUrl,
                  detail: "high",
                },
              },
            ]
          : userPrompt,
      });
      const initialRequest = {
        model,
        messages,
        tools,
        tool_choice: "auto" as const,
        stream: false as const,
        reasoning: options.reasoning
          ? { effort: options.reasoning }
          : undefined,
        providerOptions: options.providerOrder?.length
          ? {
              gateway: {
                order: options.providerOrder,
                only: options.providerOrder,
              },
            }
          : undefined,
      };
      for (let step = 0; step < maxSteps; step += 1) {
        const modelStartedAt = Date.now();
        report({
          phase: "model",
          message: `Waiting for ${model}`,
          detail: `Model step ${step + 1}${options.reasoning ? ` · reasoning ${options.reasoning}` : ""}`,
        });
        const response = await options.gateway.complete({
          ...initialRequest,
          messages,
        });
        report({
          phase: "model",
          message: `${model} responded`,
          detail: `${Date.now() - modelStartedAt}ms · model step ${step + 1}${options.reasoning ? ` · reasoning ${options.reasoning}` : ""}`,
        });
        messages.push(response);
        const calls = response.tool_calls ?? [];
        if (calls.length === 0)
          throw new Error("Quick agent stopped without submitting edits");

        for (const call of calls) {
          const args = JSON.parse(call.function.arguments) as Record<
            string,
            unknown
          >;
          if (call.function.name === "submit_edits") {
            const submission = submissionSchema.parse(args);
            const id = randomUUID();
            report({
              phase: "apply",
              message: `Validating ${submission.edits.length} proposed edit${submission.edits.length === 1 ? "" : "s"}`,
            });
            if ((request.mode ?? "preview") === "apply") {
              const changes = await project.applyEdits(submission.edits);
              undoHistory.set(id, changes);
              while (undoHistory.size > 50) {
                undoHistory.delete(undoHistory.keys().next().value!);
              }
              report({ phase: "apply", message: "Source files updated" });
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                summary: submission.summary,
                edits: submission.edits,
                applied: request.mode === "apply",
              }),
            });
            conversations.set(id, structuredClone(messages));
            if (request.continuationId) {
              conversations.delete(request.continuationId);
            }
            while (conversations.size > 50) {
              conversations.delete(conversations.keys().next().value!);
            }
            return result(
              id,
              model,
              submission.summary,
              submission.edits,
              request.mode === "apply",
            );
          }

          let output: unknown;
          const toolStartedAt = Date.now();
          if (call.function.name === "list_files") {
            report({ phase: "tool", message: "Listing project files" });
            output = await project.listFiles(
              typeof args.pattern === "string" ? args.pattern : undefined,
            );
          } else if (
            call.function.name === "search_code" &&
            typeof args.query === "string"
          ) {
            report({
              phase: "tool",
              message: `Searching code for “${args.query}”`,
            });
            output = await project.searchCode(args.query);
          } else if (
            call.function.name === "read_file" &&
            typeof args.path === "string"
          ) {
            report({ phase: "tool", message: `Reading ${args.path}` });
            output = await project.readFile(args.path);
          } else {
            output = { error: `Invalid tool call: ${call.function.name}` };
          }
          report({
            phase: "tool",
            message: `Finished ${call.function.name}`,
            detail: `${Date.now() - toolStartedAt}ms`,
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(output),
          });
        }
      }
      throw new Error(`Quick agent exceeded its ${maxSteps}-step limit`);
    },
  };
}

async function retrieveLikelyContext(
  project: ReturnType<typeof createProjectTools>,
  selections: ElementSelection[],
): Promise<string> {
  const paths = new Set<string>();
  for (const selection of selections) {
    const sourcePath = selection.sourceHint?.match(/^(.*):\d+:\d+$/)?.[1];
    if (!sourcePath) continue;
    try {
      await project.readFile(sourcePath);
      paths.add(sourcePath);
    } catch {
      // Stale browser markup should fall back to ordinary code search.
    }
  }
  const anchors = selections
    .flatMap((selection) => [
      selection.id,
      ...(selection.classNames ?? []),
      selection.text?.trim().slice(0, 120),
    ])
    .filter((value): value is string => Boolean(value?.trim()));

  for (const anchor of anchors.slice(0, 6)) {
    for (const match of await project.searchCode(anchor)) {
      const path = match.match(/^(.*?):\d+:/)?.[1];
      if (path) paths.add(path);
      if (paths.size >= 6) break;
    }
    if (paths.size >= 6) break;
  }

  const files: string[] = [];
  let totalLength = 0;
  for (const path of paths) {
    const content = await project.readFile(path);
    if (totalLength + content.length > 60_000) break;
    files.push(`\n--- ${path} ---\n${content}`);
    totalLength += content.length;
  }
  return files.length > 0
    ? `\n\nLikely relevant project files (use tools if these are insufficient):${files.join("")}`
    : "";
}

function result(
  id: string,
  model: string,
  summary: string,
  edits: TextReplacement[],
  applied: boolean,
): QuickIterationResult {
  return { id, model, summary, edits, applied };
}
