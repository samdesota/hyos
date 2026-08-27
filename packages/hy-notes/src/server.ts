import { createServer } from "node:http";
import { resolve } from "node:path";

import { hyapp } from "@hyos/hyapp";
import { createNodeGatewayHttpHandler } from "@hyos/hyapp/node";
import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";

import {
  commandRegistry,
  principalSchema,
  readPolicies,
  readRegistry,
} from "./application.js";
import { notesSchema } from "./model.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3001);
const dataDirectory = resolve(
  process.env.HY_NOTES_DATA_DIR ?? ".data/hy-notes",
);

const storage = await openNodeStorage({
  directory: dataDirectory,
  schema: notesSchema,
});
const database = await hydb.database({ schema: notesSchema, storage });
const gateway = hyapp.gateway({
  database,
  principal: principalSchema,
  registry: commandRegistry,
  readPolicies,
});

const handleGateway = createNodeGatewayHttpHandler({
  gateway,
  reads: readRegistry,
  basePath: "/api/hyapp",
  principal() {
    return { app: "hy-notes" as const };
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

  if (request.method === "GET" && url.pathname === "/api/health") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (await handleGateway(request, response)) return;

  response.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error: "Not found" }));
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, host, () => {
    server.off("error", rejectListen);
    resolveListen();
  });
});

console.log(`hy-notes gateway listening on http://${host}:${port}`);
console.log(`Persisting notes in ${dataDirectory}`);

async function close() {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error),
    );
  });
  await database.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });
}
