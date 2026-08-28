import {
  createTRPCClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
} from "@trpc/client";

import type { UiAgentRouter } from "./trpc.js";

export interface UiAgentClientOptions {
  serverUrl: string;
  WebSocket?: typeof WebSocket;
}

function normalizeServerUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function createUiAgentClient(options: UiAgentClientOptions) {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const wsClient = createWSClient({
    url: `${serverUrl.replace(/^http/, "ws")}/`,
    WebSocket: options.WebSocket,
    lazy: { enabled: true, closeMs: 1_000 },
  });
  return createTRPCClient<UiAgentRouter>({
    links: [
      splitLink({
        condition: (operation) => operation.type === "subscription",
        true: wsLink({ client: wsClient }),
        false: httpBatchLink({ url: `${serverUrl}/trpc` }),
      }),
    ],
  });
}

export type UiAgentClient = ReturnType<typeof createUiAgentClient>;
