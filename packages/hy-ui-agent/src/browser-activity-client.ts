import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";

import type { AgentActivity } from "./agent-types.js";
import type { UiAgentRouter } from "./trpc.js";

const endpoint = new URL(import.meta.url);
endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
endpoint.pathname = "/";
endpoint.search = "";
endpoint.hash = "";

const wsClient = createWSClient({
  url: endpoint.toString(),
  lazy: { enabled: true, closeMs: 2_000 },
});
const client = createTRPCClient<UiAgentRouter>({
  links: [wsLink({ client: wsClient })],
});

export function subscribeToIterationActivity(
  requestId: string,
  handlers: {
    onData(activity: AgentActivity): void;
    onError(error: unknown): void;
    onComplete(): void;
  },
) {
  return client.iteration.activity.subscribe({ requestId }, handlers);
}

export function ingestFrontendLogs(
  entries: Array<{
    level: "debug" | "info" | "warn" | "error";
    event: string;
    message: string;
    requestId?: string;
    timestamp?: number;
    data?: unknown;
  }>,
) {
  return client.telemetry.ingest.mutate({ entries });
}
