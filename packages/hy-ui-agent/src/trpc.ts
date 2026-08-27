import type { IncomingMessage, ServerResponse } from "node:http";

import { initTRPC } from "@trpc/server";
import { z } from "zod";

import type { QuickIterationAgent } from "./agent-types.js";

export interface UiAgentContext {
  request: IncomingMessage;
  response: ServerResponse;
}

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

export function createUiAgentRouter(agent: QuickIterationAgent) {
  return t.router({
    system: t.router({
      health: t.procedure.query(() => ({
        status: "ok" as const,
        protocol: "trpc" as const,
        version: 1,
      })),
    }),
    iteration: t.router({
      run: t.procedure
        .input(
          z.object({
            instruction: z.string().min(1).max(4_000),
            selection: selectionSchema,
            mode: z.enum(["preview", "apply"]).default("preview"),
          }),
        )
        .mutation(({ input }) => agent.run(input)),
    }),
  });
}

export type UiAgentRouter = ReturnType<typeof createUiAgentRouter>;
