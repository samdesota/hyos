import type { Query } from "@hyos/hydb";

import type {
  GatewayClientTransport,
  GatewayCommandRequest,
  GatewayCommandResponse,
} from "./gateway-client.js";
import type { GatewayReadRegistry } from "./registry.js";
import { parseWire, stringifyWire } from "./wire.js";

export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

export type GatewaySubscriptionMessage =
  | Readonly<{ type: "data"; value: unknown }>
  | Readonly<{ type: "error"; error: string }>;

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function queryNames(
  reads: GatewayReadRegistry,
): ReadonlyMap<Query<any>, string> {
  const names = new Map<Query<any>, string>();
  for (const [name, query] of Object.entries(reads)) {
    if (names.has(query)) {
      throw new TypeError("A gateway read query may only be registered once");
    }
    names.set(query, name);
  }
  return names;
}

async function responseValue(response: Response): Promise<unknown> {
  const text = await response.text();
  let value: unknown;
  try {
    value = parseWire(text);
  } catch (error) {
    throw new GatewayHttpError(
      response.status,
      error instanceof Error ? error.message : "Invalid gateway response",
    );
  }
  if (!response.ok) {
    const message =
      value !== null && typeof value === "object" && "error" in value
        ? String(value.error)
        : `Gateway request failed (${response.status})`;
    throw new GatewayHttpError(response.status, message);
  }
  return value;
}

export function httpGatewayTransport(options: {
  reads: GatewayReadRegistry;
  baseUrl?: string;
  headers?: () => Readonly<Record<string, string>>;
  onSubscriptionError?: (error: unknown) => void;
}): GatewayClientTransport {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "/api/hyapp");
  const names = queryNames(options.reads);
  const nameFor = (query: Query<any>) => {
    const name = names.get(query);
    if (name === undefined) {
      throw new TypeError(
        "Query is not registered with this gateway transport",
      );
    }
    return encodeURIComponent(name);
  };
  const headers = () => options.headers?.() ?? {};

  return Object.freeze({
    async fetch(query: Query<any>) {
      return responseValue(
        await globalThis.fetch(`${baseUrl}/reads/${nameFor(query)}`, {
          headers: headers(),
        }),
      );
    },

    subscribe(
      query: Query<any>,
      listener: (result: unknown) => void,
      onError?: (error: unknown) => void,
    ) {
      const controller = new AbortController();
      const report = (error: unknown) => {
        onError?.(error);
        options.onSubscriptionError?.(error);
      };
      void (async () => {
        const response = await globalThis.fetch(
          `${baseUrl}/subscriptions/${nameFor(query)}`,
          { headers: headers(), signal: controller.signal },
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
            if (line.length === 0) continue;
            const message = parseWire(line) as GatewaySubscriptionMessage;
            if (message.type === "data") listener(message.value);
            else if (message.type === "error") {
              throw new GatewayHttpError(500, message.error);
            } else {
              throw new TypeError("Invalid gateway subscription message");
            }
          }
        }
      })().catch((error: unknown) => {
        if (!controller.signal.aborted) report(error);
      });
      return () => controller.abort();
    },

    async dispatch(
      request: GatewayCommandRequest,
    ): Promise<GatewayCommandResponse> {
      const response = await globalThis.fetch(
        `${baseUrl}/commands/${encodeURIComponent(request.command)}`,
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
