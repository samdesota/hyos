import type { Query } from "@hyos/hydb";
import type {
  GatewayClientTransport,
  GatewayCommandRequest,
  GatewayCommandResponse,
} from "@hyos/hyapp";

import { readRegistry, type ReadName } from "./data.js";
import { parseWire, stringifyWire } from "./wire.js";

function nameForQuery(query: Query<any>): ReadName {
  const match = Object.entries(readRegistry).find(
    ([, value]) => value === query,
  );
  if (match === undefined)
    throw new TypeError("Query is not registered with this gateway");
  return match[0] as ReadName;
}

async function responseValue(response: Response): Promise<unknown> {
  const value = parseWire(await response.text());
  if (!response.ok) {
    const message =
      value !== null && typeof value === "object" && "error" in value
        ? String(value.error)
        : `Gateway request failed (${response.status})`;
    throw new Error(message);
  }
  return value;
}

export function browserGatewayTransport(options: {
  principalId(): string;
  onSubscriptionError?(error: unknown): void;
}): GatewayClientTransport {
  const headers = () => ({ "x-demo-user-id": options.principalId() });

  return Object.freeze({
    async fetch(query: Query<any>) {
      const response = await fetch(`/api/reads/${nameForQuery(query)}`, {
        headers: headers(),
      });
      return responseValue(response);
    },

    subscribe(query: Query<any>, listener: (result: unknown) => void) {
      const controller = new AbortController();
      void (async () => {
        const response = await fetch(
          `/api/subscriptions/${nameForQuery(query)}`,
          {
            headers: headers(),
            signal: controller.signal,
          },
        );
        if (!response.ok || response.body === null) {
          await responseValue(response);
          return;
        }
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let pending = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += value;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (line.length > 0) listener(parseWire(line));
          }
        }
      })().catch((error: unknown) => {
        if (!controller.signal.aborted) options.onSubscriptionError?.(error);
      });
      return () => controller.abort();
    },

    async execute(
      request: GatewayCommandRequest,
    ): Promise<GatewayCommandResponse> {
      const response = await fetch(
        `/api/commands/${encodeURIComponent(request.command)}`,
        {
          method: "POST",
          headers: { ...headers(), "content-type": "application/json" },
          body: stringifyWire(request),
        },
      );
      return (await responseValue(response)) as GatewayCommandResponse;
    },
  });
}
