import type { IncomingMessage, ServerResponse } from "node:http";

import { AuthorizationError } from "@hyos/hydb";
import { ZodError } from "zod";

import type { Gateway } from "../gateway.js";
import type { GatewayCommandRequest } from "../gateway-client.js";
import { GatewayHttpError, type GatewaySubscriptionMessage } from "../http.js";
import type {
  GatewayReadRegistry,
  ServerCommandRegistry,
} from "../registry.js";
import { parseWire, stringifyWire } from "../wire.js";

export type NodeGatewayHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

function normalizeBasePath(value: string): string {
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(stringifyWire(value));
}

async function readBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      throw new GatewayHttpError(413, "Gateway request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    return parseWire(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GatewayHttpError(400, "Invalid gateway request body");
  }
}

function routeName(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const suffix = pathname.slice(prefix.length);
  if (suffix.length === 0 || suffix.includes("/")) return undefined;
  try {
    return decodeURIComponent(suffix);
  } catch {
    throw new GatewayHttpError(400, "Invalid gateway route");
  }
}

function statusFor(error: unknown): number {
  if (error instanceof GatewayHttpError) return error.status;
  if (error instanceof AuthorizationError) return 403;
  if (error instanceof ZodError) return 400;
  return 500;
}

function messageFor(error: unknown, status: number): string {
  if (error instanceof ZodError) return "Gateway request validation failed";
  if (status < 500 && error instanceof Error) return error.message;
  return "Internal gateway error";
}

export function createNodeGatewayHttpHandler<
  PrincipalInput,
  Commands extends ServerCommandRegistry,
>(options: {
  gateway: Gateway<PrincipalInput, Commands>;
  reads: GatewayReadRegistry;
  principal(
    request: IncomingMessage,
  ): PrincipalInput | PromiseLike<PrincipalInput>;
  basePath?: string;
  maxBodyBytes?: number;
  onError?: (error: unknown, request: IncomingMessage) => void;
}): NodeGatewayHttpHandler {
  const basePath = normalizeBasePath(options.basePath ?? "/api/hyapp");
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;

  return async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    try {
      const principal = await options.principal(request);
      const session = options.gateway.forPrincipal(principal);
      const readName = routeName(url.pathname, `${basePath}/reads/`);
      if (request.method === "GET" && readName !== undefined) {
        const query = options.reads[readName];
        if (query === undefined)
          throw new GatewayHttpError(404, "Unknown gateway read");
        sendJson(response, 200, await session.fetch(query));
        return true;
      }

      const subscriptionName = routeName(
        url.pathname,
        `${basePath}/subscriptions/`,
      );
      if (request.method === "GET" && subscriptionName !== undefined) {
        const query = options.reads[subscriptionName];
        if (query === undefined)
          throw new GatewayHttpError(404, "Unknown gateway read");
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const unsubscribe = session.subscribe(query, (value) => {
          const message: GatewaySubscriptionMessage = { type: "data", value };
          response.write(`${stringifyWire(message)}\n`);
        });
        response.once("close", unsubscribe);
        return true;
      }

      const commandName = routeName(url.pathname, `${basePath}/commands/`);
      if (request.method === "POST" && commandName !== undefined) {
        if (!Object.hasOwn(options.gateway.registry, commandName)) {
          throw new GatewayHttpError(404, "Unknown gateway command");
        }
        const body = await readBody(request, maxBodyBytes);
        if (
          body === null ||
          typeof body !== "object" ||
          !("input" in body) ||
          !("invocationId" in body) ||
          typeof body.invocationId !== "string" ||
          !("command" in body) ||
          body.command !== commandName
        ) {
          throw new GatewayHttpError(400, "Invalid gateway command request");
        }
        const result = await session.execute(
          commandName as Extract<keyof Commands, string>,
          (body as GatewayCommandRequest).input as never,
        );
        sendJson(response, 200, { result });
        return true;
      }

      throw new GatewayHttpError(404, "Unknown gateway route");
    } catch (error) {
      const status = statusFor(error);
      if (status >= 500) options.onError?.(error, request);
      const message = messageFor(error, status);
      if (response.headersSent) {
        const streamError: GatewaySubscriptionMessage = {
          type: "error",
          error: message,
        };
        response.end(`${stringifyWire(streamError)}\n`);
      } else {
        sendJson(response, status, { error: message });
      }
      return true;
    }
  };
}
