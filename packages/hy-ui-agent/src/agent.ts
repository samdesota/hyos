import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  ElementSelection,
  QuickIterationAgent,
  QuickIterationRequest,
  QuickIterationResult,
  TextReplacement,
} from "./agent-types.js";
import type { GatewayMessage, GatewayTransport } from "./gateway.js";
import { createProjectTools } from "./project-tools.js";

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
Use the selected DOM details to locate the implementation. Inspect files before editing.
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
}

export function createQuickIterationAgent(
  options: CreateQuickIterationAgentOptions,
): QuickIterationAgent {
  const project = createProjectTools(options.projectRoot);
  const model = options.model ?? "zai/glm-5.3-flash";
  const maxSteps = options.maxSteps ?? 10;

  return {
    async run(
      rawRequest: QuickIterationRequest,
    ): Promise<QuickIterationResult> {
      const request = inputSchema.parse(rawRequest);
      const context = await retrieveLikelyContext(project, request.selection);
      const messages: GatewayMessage[] = [
        { role: "system", content: systemPrompt() },
        {
          role: "user",
          content: `Instruction:\n${request.instruction}\n\nSelected element:\n${JSON.stringify(request.selection, null, 2)}${context}`,
        },
      ];

      for (let step = 0; step < maxSteps; step += 1) {
        const response = await options.gateway.complete({
          model,
          messages,
          tools,
          tool_choice: "auto",
          stream: false,
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
            if ((request.mode ?? "preview") === "apply")
              await project.applyEdits(submission.edits);
            return result(
              model,
              submission.summary,
              submission.edits,
              request.mode === "apply",
            );
          }

          let output: unknown;
          if (call.function.name === "list_files") {
            output = await project.listFiles(
              typeof args.pattern === "string" ? args.pattern : undefined,
            );
          } else if (
            call.function.name === "search_code" &&
            typeof args.query === "string"
          ) {
            output = await project.searchCode(args.query);
          } else if (
            call.function.name === "read_file" &&
            typeof args.path === "string"
          ) {
            output = await project.readFile(args.path);
          } else {
            output = { error: `Invalid tool call: ${call.function.name}` };
          }
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
  selection: ElementSelection,
): Promise<string> {
  const anchors = [
    selection.sourceHint,
    selection.id,
    ...(selection.classNames ?? []),
    selection.text?.trim().slice(0, 120),
  ].filter((value): value is string => Boolean(value?.trim()));
  const paths = new Set<string>();

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
  model: string,
  summary: string,
  edits: TextReplacement[],
  applied: boolean,
): QuickIterationResult {
  return { id: randomUUID(), model, summary, edits, applied };
}
