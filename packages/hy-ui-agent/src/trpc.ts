import type { IncomingMessage, ServerResponse } from "node:http";

import { initTRPC } from "@trpc/server";

export interface UiAgentContext {
  request: IncomingMessage;
  response: ServerResponse;
}

const t = initTRPC.context<UiAgentContext>().create();

export const uiAgentRouter = t.router({
  system: t.router({
    health: t.procedure.query(() => ({
      status: "ok" as const,
      protocol: "trpc" as const,
      version: 1,
    })),
  }),
});

export type UiAgentRouter = typeof uiAgentRouter;
