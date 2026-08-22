import { createServer, type ServerResponse } from "node:http";
import { readFile, rm, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";
import { hyapp } from "@hyos/hyapp";
import { GatewayHttpError } from "@hyos/hyapp/http";
import { createNodeGatewayHttpHandler } from "@hyos/hyapp/node";

import {
  commandRegistry,
  demoSchema,
  principalSchema,
  readPolicies,
  readRegistry,
} from "./data.js";
import { demoPeople } from "./demo-people.js";
import { seedStorage } from "./seed.js";

const knownUsers = new Set<string>(demoPeople.map((user) => user.id));
const contentTypes: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
});

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
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
  const handleGateway = createNodeGatewayHttpHandler({
    gateway,
    reads: readRegistry,
    basePath: "/api",
    principal(request) {
      const userId = request.headers["x-demo-user-id"];
      if (typeof userId !== "string" || !knownUsers.has(userId)) {
        throw new GatewayHttpError(401, "Choose a valid demo user");
      }
      return { userId };
    },
    onError(error) {
      console.error(error);
    },
  });

  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? host}`,
    );
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (await handleGateway(request, response)) return;
    if (
      request.method === "GET" &&
      options?.staticDirectory !== undefined &&
      (await serveStatic(pathname, response, options.staticDirectory))
    ) {
      return;
    }
    sendJson(response, 404, { error: "Not found" });
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
