import { createTRPCClient, httpBatchLink } from "@trpc/client";

import type { UiAgentRouter } from "./trpc.js";

export interface UiAgentClientOptions {
  serverUrl: string;
}

function normalizeServerUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function createUiAgentClient(options: UiAgentClientOptions) {
  return createTRPCClient<UiAgentRouter>({
    links: [
      httpBatchLink({
        url: `${normalizeServerUrl(options.serverUrl)}/trpc`,
      }),
    ],
  });
}

export type UiAgentClient = ReturnType<typeof createUiAgentClient>;
