import type { HtmlTagDescriptor, Plugin } from "vite";

import {
  createUiAgentServer,
  type UiAgentServer,
  type UiAgentServerOptions,
} from "./server.js";

export interface UiAgentPluginOptions {
  /** Start a companion server with these options. */
  server?: UiAgentServerOptions;
  /** Use an already-running UI agent server instead of starting one. */
  serverUrl?: string;
}

function normalizeServerUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function uiAgent(options: UiAgentPluginOptions = {}): Plugin {
  if (options.server !== undefined && options.serverUrl !== undefined) {
    throw new Error("uiAgent accepts either server or serverUrl, not both");
  }

  let companionServer: UiAgentServer | undefined;
  let activeServerUrl = options.serverUrl
    ? normalizeServerUrl(options.serverUrl)
    : undefined;

  return {
    name: "hyos-ui-agent",
    apply: "serve",
    async configureServer(viteServer) {
      if (activeServerUrl === undefined) {
        companionServer = createUiAgentServer(options.server ?? { port: 0 });
        activeServerUrl = await companionServer.start();
        viteServer.config.logger.info(`  UI Agent: ${activeServerUrl}/overlay`);
      }

      viteServer.httpServer?.once("close", () => {
        void companionServer?.close();
      });
    },
    transformIndexHtml(): HtmlTagDescriptor[] {
      if (activeServerUrl === undefined) {
        throw new Error("UI agent server was not initialized");
      }

      return [
        {
          tag: "script",
          attrs: {
            type: "module",
            src: `${activeServerUrl}/client.js`,
            "data-hyos-ui-agent": "",
          },
          injectTo: "body",
        },
      ];
    },
  };
}
