import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadEnv, type HtmlTagDescriptor, type Plugin } from "vite";

import {
  createHyeditServer,
  type HyeditServer,
  type HyeditServerOptions,
} from "./server.js";
import { parseGatewayReasoningEffort } from "./gateway.js";

export {
  reactSourceLocations,
  type ReactSourceLocationsOptions,
} from "./react-source-locations.js";

export interface HyeditPluginOptions {
  /** Start a companion server with these options. */
  server?: HyeditServerOptions;
  /** Use an already-running hyedit server instead of starting one. */
  serverUrl?: string;
}

function normalizeServerUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function findEnvDir(start: string): string {
  let directory = start;
  while (true) {
    if (existsSync(join(directory, ".env"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return start;
    directory = parent;
  }
}

export function hyedit(options: HyeditPluginOptions = {}): Plugin {
  if (options.server !== undefined && options.serverUrl !== undefined) {
    throw new Error("hyedit accepts either server or serverUrl, not both");
  }

  let companionServer: HyeditServer | undefined;
  let projectRoot: string | undefined;
  let environment: Record<string, string> = {};
  let activeServerUrl = options.serverUrl
    ? normalizeServerUrl(options.serverUrl)
    : undefined;

  return {
    name: "hyedit",
    apply: "serve",
    configResolved(config) {
      projectRoot = config.root;
      environment = loadEnv(
        config.mode,
        findEnvDir(config.envDir || config.root),
        "",
      );
    },
    async configureServer(viteServer) {
      if (activeServerUrl === undefined) {
        companionServer = createHyeditServer({
          port: 0,
          projectRoot,
          apiKey: environment.AI_GATEWAY_API_KEY,
          model: environment.HYEDIT_MODEL,
          reasoning: parseGatewayReasoningEffort(environment.HYEDIT_REASONING),
          providerOrder: environment.HYEDIT_PROVIDER_ORDER?.split(",")
            .map((provider) => provider.trim())
            .filter(Boolean),
          ...options.server,
        });
        activeServerUrl = await companionServer.start();
        viteServer.config.logger.info(`  hyedit: ${activeServerUrl}/overlay`);
      }

      viteServer.httpServer?.once("close", () => {
        void companionServer?.close();
      });
    },
    transformIndexHtml(): HtmlTagDescriptor[] {
      if (activeServerUrl === undefined) {
        throw new Error("hyedit server was not initialized");
      }

      return [
        {
          tag: "script",
          attrs: {
            type: "module",
            src: `${activeServerUrl}/client.js`,
            "data-hyedit": "",
          },
          injectTo: "body",
        },
      ];
    },
  };
}
