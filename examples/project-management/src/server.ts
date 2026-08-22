import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, rm, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import { AuthorizationError, hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";
import { hyapp, type GatewaySession } from "@hyos/hyapp";
import { ZodError } from "zod";

import {
  commandRegistry,
  demoSchema,
  principalSchema,
  readPolicies,
  readRegistry,
  type ReadName,
} from "./data.js";
import { demoUsers, seedStorage } from "./seed.js";
import { parseWire, stringifyWire } from "./wire.js";

const knownUsers = new Set<string>(demoUsers.map((user) => user.id));
const contentTypes: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
});

type AppSession = GatewaySession<typeof commandRegistry>;

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(stringifyWire(value));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) throw new TypeError("Request body is too large");
    chunks.push(buffer);
  }
  return parseWire(Buffer.concat(chunks).toString("utf8"));
}

function sessionFor(
  request: IncomingMessage,
  gateway: ReturnType<typeof hyapp.gateway>,
): AppSession {
  const userId = request.headers["x-demo-user-id"];
  if (typeof userId !== "string" || !knownUsers.has(userId)) {
    throw new AuthorizationError("Choose a valid demo user");
  }
  return gateway.forPrincipal({ userId }) as AppSession;
}

function readName(pathname: string, prefix: string): ReadName | undefined {
  const value = decodeURIComponent(pathname.slice(prefix.length));
  return Object.hasOwn(readRegistry, value) ? (value as ReadName) : undefined;
}

async function serveStatic(
  pathname: string,
  response: ServerResponse,
  staticDirectory: string,
): Promise<boolean> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = normalize(relative);
  if (normalized.startsWith("..") || normalized.includes("/../")) return false;
  let filePath = join(staticDirectory, normalized);
  try {
    if ((await stat(filePath)).isDirectory())
      filePath = join(filePath, "index.html");
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type":
        contentTypes[extname(filePath)] ?? "application/octet-stream",
    });
    response.end(body);
    return true;
  } catch {
    if (extname(pathname) !== "") return false;
    try {
      const body = await readFile(join(staticDirectory, "index.html"));
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(body);
      return true;
    } catch {
      return false;
    }
  }
}

function errorResponse(response: ServerResponse, error: unknown): void {
  if (error instanceof AuthorizationError) {
    sendJson(response, 403, { error: error.message });
    return;
  }
  if (error instanceof ZodError || error instanceof TypeError) {
    sendJson(response, 400, {
      error:
        error instanceof ZodError ? "Request validation failed" : error.message,
    });
    return;
  }
  console.error(error);
  sendJson(response, 500, { error: "Internal server error" });
}

export async function startProjectManagementServer(options?: {
  host?: string;
  port?: number;
  dataDirectory?: string;
  staticDirectory?: string;
  resetData?: boolean;
}) {
  const host = options?.host ?? "127.0.0.1";
  const port = options?.port ?? 3001;
  const dataDirectory = resolve(options?.dataDirectory ?? ".data");
  if (options?.resetData === true)
    await rm(dataDirectory, { recursive: true, force: true });

  const storage = await openNodeStorage({
    directory: dataDirectory,
    schema: demoSchema,
  });
  await seedStorage(storage);
  const database = await hydb.database({ schema: demoSchema, storage });
  const gateway = hyapp.gateway({
    database,
    principal: principalSchema,
    registry: commandRegistry,
    readPolicies,
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? host}`,
      );
      const pathname = url.pathname;

      if (request.method === "GET" && pathname === "/api/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && pathname.startsWith("/api/reads/")) {
        const name = readName(pathname, "/api/reads/");
        if (name === undefined) {
          sendJson(response, 404, { error: "Unknown read" });
          return;
        }
        const result = await sessionFor(request, gateway).fetch(
          readRegistry[name],
        );
        sendJson(response, 200, result);
        return;
      }

      if (
        request.method === "GET" &&
        pathname.startsWith("/api/subscriptions/")
      ) {
        const name = readName(pathname, "/api/subscriptions/");
        if (name === undefined) {
          sendJson(response, 404, { error: "Unknown read" });
          return;
        }
        const session = sessionFor(request, gateway);
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const unsubscribe = session.subscribe(readRegistry[name], (result) => {
          response.write(`${stringifyWire(result)}\n`);
        });
        request.once("close", unsubscribe);
        return;
      }

      if (request.method === "POST" && pathname.startsWith("/api/commands/")) {
        const name = decodeURIComponent(
          pathname.slice("/api/commands/".length),
        );
        if (!Object.hasOwn(commandRegistry, name)) {
          sendJson(response, 404, { error: "Unknown command" });
          return;
        }
        const requestBody = (await readBody(request)) as { input?: unknown };
        const result = await sessionFor(request, gateway).execute(
          name as keyof typeof commandRegistry,
          requestBody.input as never,
        );
        sendJson(response, 200, { result });
        return;
      }

      if (
        request.method === "GET" &&
        options?.staticDirectory !== undefined &&
        (await serveStatic(pathname, response, options.staticDirectory))
      ) {
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      errorResponse(response, error);
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  return Object.freeze({
    host,
    port,
    async close() {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error),
        );
      });
      await database.close();
    },
  });
}

const running = await startProjectManagementServer({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
  dataDirectory: process.env.HYAPP_DATA_DIR,
  staticDirectory: process.env.HYAPP_STATIC_DIR,
  resetData: process.env.HYAPP_RESET_DATA === "1",
});

console.log(
  `Project management gateway listening on http://${running.host}:${running.port}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void running.close().finally(() => process.exit(0));
  });
}
