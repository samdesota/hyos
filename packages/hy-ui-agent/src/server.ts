import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";

import { createQuickIterationAgent } from "./agent.js";
import type { QuickIterationAgent } from "./agent-types.js";
import { renderClientScript, renderOverlayHtml } from "./assets.js";
import {
  createVercelGateway,
  parseGatewayReasoningEffort,
  type GatewayReasoningEffort,
} from "./gateway.js";
import { createUiAgentRouter } from "./trpc.js";
import { renderHtml2CanvasScript } from "./vendor.js";
import { renderActivityClientScript } from "./browser-bundle.js";
import {
  createDevelopmentTelemetry,
  type DevelopmentTelemetryOptions,
} from "./telemetry.js";

export interface UiAgentServerOptions {
  host?: string;
  port?: number;
  projectRoot?: string;
  apiKey?: string;
  model?: string;
  reasoning?: GatewayReasoningEffort;
  providerOrder?: string[];
  gatewayBaseUrl?: string;
  agent?: QuickIterationAgent;
  telemetry?: DevelopmentTelemetryOptions;
}

export interface UiAgentServer {
  readonly url: string | undefined;
  start(): Promise<string>;
  close(): Promise<void>;
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function publicHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "localhost" : host;
}

export function createUiAgentServer(
  options: UiAgentServerOptions = {},
): UiAgentServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const projectRoot = options.projectRoot ?? process.cwd();
  let serverUrl: string | undefined;
  const telemetry = createDevelopmentTelemetry(projectRoot, options.telemetry);

  const apiKey = options.apiKey ?? process.env.AI_GATEWAY_API_KEY;
  const unavailableAgent = {
    run(): Promise<never> {
      return Promise.reject(
        new Error("AI_GATEWAY_API_KEY is required to run a quick iteration"),
      );
    },
  };
  const agent =
    options.agent ??
    (apiKey
      ? createQuickIterationAgent({
          projectRoot,
          gateway: createVercelGateway({
            apiKey,
            baseUrl: options.gatewayBaseUrl,
          }),
          model: options.model ?? process.env.UI_AGENT_MODEL,
          reasoning: parseGatewayReasoningEffort(
            options.reasoning ?? process.env.UI_AGENT_REASONING,
          ),
          providerOrder:
            options.providerOrder ??
            process.env.UI_AGENT_PROVIDER_ORDER?.split(",")
              .map((provider) => provider.trim())
              .filter(Boolean),
        })
      : unavailableAgent);
  const router = createUiAgentRouter(agent, undefined, telemetry);

  const trpcHandler = createHTTPHandler({
    router,
    basePath: "/trpc/",
    createContext({ req, res }) {
      void req;
      void res;
      return {};
    },
    onError({ error, path }) {
      telemetry.log({
        source: "backend",
        level: "error",
        event: "trpc.error",
        message: error.message,
        data: { path },
      });
    },
  });

  const server = createServer((request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`,
    );
    telemetry.log({
      source: "backend",
      level: "debug",
      event: "http.request",
      message: `${request.method ?? "GET"} ${url.pathname}`,
    });

    if (url.pathname.startsWith("/trpc/")) {
      setCorsHeaders(response);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
      } else {
        trpcHandler(request, response);
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      send(
        response,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({ status: "ok" }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/client.js") {
      send(
        response,
        200,
        "text/javascript; charset=utf-8",
        renderClientScript(),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/activity-client.js") {
      void renderActivityClientScript()
        .then((body) =>
          send(response, 200, "text/javascript; charset=utf-8", body),
        )
        .catch((error) =>
          send(
            response,
            500,
            "text/plain; charset=utf-8",
            error instanceof Error ? error.message : "Bundle failed",
          ),
        );
      return;
    }

    if (request.method === "GET" && url.pathname === "/html2canvas.js") {
      send(
        response,
        200,
        "text/javascript; charset=utf-8",
        renderHtml2CanvasScript(),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/overlay") {
      send(response, 200, "text/html; charset=utf-8", renderOverlayHtml());
      return;
    }

    send(response, 404, "text/plain; charset=utf-8", "Not found");
  });
  const wss = new WebSocketServer({ server });
  applyWSSHandler({
    wss,
    router,
    createContext: () => ({}),
    keepAlive: { enabled: true, pingMs: 30_000, pongWaitMs: 5_000 },
    onError({ error, path }) {
      telemetry.log({
        source: "backend",
        level: "error",
        event: "websocket.error",
        message: error.message,
        data: { path },
      });
    },
  });

  return {
    get url() {
      return serverUrl;
    },
    start() {
      if (serverUrl !== undefined) return Promise.resolve(serverUrl);

      return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address() as AddressInfo;
          serverUrl = `http://${publicHost(host)}:${address.port}`;
          telemetry.log({
            source: "backend",
            level: "info",
            event: "server.started",
            message: serverUrl,
            data: { host, port: address.port },
          });
          resolve(serverUrl);
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      if (!server.listening) return Promise.resolve();

      return new Promise((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close((error) => {
          if (error) reject(error);
          else {
            telemetry.log({
              source: "backend",
              level: "info",
              event: "server.stopped",
              message: "UI agent server stopped",
            });
            telemetry.close();
            serverUrl = undefined;
            resolve();
          }
        });
      });
    },
  };
}
