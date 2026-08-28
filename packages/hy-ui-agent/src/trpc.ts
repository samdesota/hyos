import { initTRPC } from "@trpc/server";
import { z } from "zod";

import type { QuickIterationAgent } from "./agent-types.js";
import { IterationActivityBus } from "./activity.js";
import type { TelemetryStore } from "./telemetry.js";

export interface UiAgentContext {}

const t = initTRPC.context<UiAgentContext>().create();

const selectionSchema = z.object({
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
});

const screenshotSchema = z.object({
  dataUrl: z.string().startsWith("data:image/").max(4_000_000),
  width: z.number().positive().max(4_096),
  height: z.number().positive().max(4_096),
});

export function createUiAgentRouter(
  agent: QuickIterationAgent,
  activity = new IterationActivityBus(),
  telemetry?: TelemetryStore,
) {
  return t.router({
    system: t.router({
      health: t.procedure.query(() => ({
        status: "ok" as const,
        protocol: "trpc" as const,
        version: 1,
      })),
    }),
    telemetry: t.router({
      ingest: t.procedure
        .input(
          z.object({
            entries: z
              .array(
                z.object({
                  level: z.enum(["debug", "info", "warn", "error"]),
                  event: z.string().min(1).max(200),
                  message: z.string().max(20_000),
                  requestId: z.string().min(1).max(200).optional(),
                  timestamp: z.number().optional(),
                  data: z.unknown().optional(),
                }),
              )
              .max(100),
          }),
        )
        .mutation(({ input }) => {
          for (const entry of input.entries) {
            telemetry?.log({ source: "frontend", ...entry });
          }
          return { accepted: input.entries.length };
        }),
      recent: t.procedure
        .input(
          z.object({ limit: z.number().int().min(1).max(1_000).optional() }),
        )
        .query(({ input }) => telemetry?.recent(input.limit) ?? []),
    }),
    iteration: t.router({
      activity: t.procedure
        .input(z.object({ requestId: z.string().min(1).max(200) }))
        .subscription(({ input, signal }) =>
          activity.subscribe(
            input.requestId,
            signal ?? new AbortController().signal,
          ),
        ),
      run: t.procedure
        .input(
          z.object({
            requestId: z.string().min(1).max(200),
            instruction: z.string().min(1).max(4_000),
            selection: selectionSchema,
            contextElements: z.array(selectionSchema).max(60).optional(),
            screenshot: screenshotSchema.optional(),
            mode: z.enum(["preview", "apply"]).default("preview"),
          }),
        )
        .mutation(async ({ input }) => {
          const { requestId, ...request } = input;
          const startedAt = Date.now();
          telemetry?.log({
            source: "agent",
            level: "info",
            event: "iteration.started",
            message: request.instruction,
            requestId,
            data: {
              mode: request.mode,
              selection: request.selection,
              contextElementCount: request.contextElements?.length ?? 0,
              hasScreenshot: Boolean(request.screenshot),
            },
          });
          try {
            const result = await agent.run(request, (event) => {
              activity.publish(requestId, event);
              telemetry?.log({
                source: "agent",
                level: "info",
                event: `agent.${event.phase}`,
                message: event.message,
                requestId,
                data: event.detail ? { detail: event.detail } : undefined,
              });
            });
            activity.publish(requestId, {
              phase: "complete",
              message: "Iteration complete",
            });
            telemetry?.log({
              source: "agent",
              level: "info",
              event: "iteration.completed",
              message: result.summary,
              requestId,
              data: {
                durationMs: Date.now() - startedAt,
                model: result.model,
                editCount: result.edits.length,
                applied: result.applied,
              },
            });
            return result;
          } catch (error) {
            activity.publish(requestId, {
              phase: "error",
              message:
                error instanceof Error ? error.message : "Iteration failed",
            });
            telemetry?.log({
              source: "agent",
              level: "error",
              event: "iteration.failed",
              message:
                error instanceof Error ? error.message : "Iteration failed",
              requestId,
              data: { durationMs: Date.now() - startedAt },
            });
            throw error;
          }
        }),
    }),
  });
}

export type UiAgentRouter = ReturnType<typeof createUiAgentRouter>;
