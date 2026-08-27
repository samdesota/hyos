import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";

import { renderClientScript, renderOverlayHtml } from "./assets.js";
import { uiAgentRouter } from "./trpc.js";

export interface UiAgentServerOptions {
  host?: string;
  port?: number;
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
  let serverUrl: string | undefined;

  const trpcHandler = createHTTPHandler({
    router: uiAgentRouter,
    basePath: "/trpc/",
    createContext({ req, res }) {
      return { request: req, response: res };
    },
  });

  const server = createServer((request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`,
    );

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

    if (request.method === "GET" && url.pathname === "/overlay") {
      send(response, 200, "text/html; charset=utf-8", renderOverlayHtml());
      return;
    }

    send(response, 404, "text/plain; charset=utf-8", "Not found");
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
        server.close((error) => {
          if (error) reject(error);
          else {
            serverUrl = undefined;
            resolve();
          }
        });
      });
    },
  };
}
