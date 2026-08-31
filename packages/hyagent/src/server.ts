import { createServer } from "node:http";
import { basename, resolve } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";
import { WebSocketServer } from "ws";

import { createLiterateAgent } from "./agent.js";
import { createNativeFolderPicker } from "./folder-picker.js";
import { createVercelGateway, type GatewayTransport } from "./gateway.js";
import { hyagentSchema } from "./model.js";
import { createProjectTools, type RepositorySpec } from "./project-tools.js";
import { createHyagentStore } from "./store.js";
import { createHyagentRouter } from "./trpc.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.HYAGENT_PORT ?? 4328);
const dataDirectory = resolve(
  process.env.HYAGENT_DATA_DIR ?? ".data/hyagent-prototype-v2",
);

const storage = await openNodeStorage({
  directory: dataDirectory,
  schema: hyagentSchema,
});
const database = await hydb.database({ schema: hyagentSchema, storage });
const store = createHyagentStore(database);

function repositorySpecs(): RepositorySpec[] {
  const configured = process.env.HYAGENT_REPOSITORIES;
  if (!configured) {
    const root = process.env.HYAGENT_PROJECT_ROOT;
    return root ? [{ name: basename(root), root: resolve(root) }] : [];
  }
  const entries = Object.entries(
    JSON.parse(configured) as Record<string, string>,
  );
  if (entries.length === 0) {
    throw new Error(
      "HYAGENT_REPOSITORIES must contain at least one repository",
    );
  }
  return entries.map(([name, root]) => ({ name, root: resolve(root) }));
}

const repositories = repositorySpecs();
const project = createProjectTools(repositories);
const folderPicker = createNativeFolderPicker();
const apiKey = process.env.AI_GATEWAY_API_KEY;
const unavailableGateway: GatewayTransport = {
  complete() {
    return Promise.reject(
      new Error(
        "Set AI_GATEWAY_API_KEY before asking the prototype agent to revise",
      ),
    );
  },
};
const gateway = apiKey
  ? createVercelGateway({
      apiKey,
      baseUrl: process.env.AI_GATEWAY_BASE_URL,
    })
  : unavailableGateway;
const agent = createLiterateAgent({
  store,
  project,
  gateway,
  model: process.env.HYAGENT_MODEL,
});
const router = createHyagentRouter({
  store,
  project,
  agent,
  folderPicker,
  agentConfigured: Boolean(apiKey),
});

const handler = createHTTPHandler({
  router,
  basePath: "/trpc/",
  createContext: () => ({}),
  onError({ error }) {
    console.error(error);
  },
});

const server = createServer((request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  handler(request, response);
});
const wss = new WebSocketServer({ server });
applyWSSHandler({
  wss,
  router,
  createContext: () => ({}),
  keepAlive: { enabled: true, pingMs: 30_000, pongWaitMs: 5_000 },
  onError({ error }) {
    console.error(error);
  },
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, host, () => {
    server.off("error", rejectListen);
    resolveListen();
  });
});

console.log(`hyagent server listening on http://${host}:${port}`);
console.log(
  `Reviewing repositories ${repositories.map(({ name, root }) => `${name}=${root}`).join(", ")}`,
);

async function close() {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error),
    );
  });
  await database.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void close().finally(() => process.exit(0)));
}
