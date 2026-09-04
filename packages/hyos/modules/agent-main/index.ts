import path from "node:path";

import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";
import type { BrowserWindow } from "electron";

import { agentCapability } from "../../capabilities/agent.js";
import type { MainRemoteCapabilities } from "../../remote-capabilities.js";
import { defineModule } from "../../runtime.js";
import { createAgentHost } from "./host.js";
import { agentSchema } from "./model.js";
import { createAgentProviders } from "./providers/index.js";
import { createAgentStore } from "./store.js";

type AgentMainConfig = Readonly<{
  storagePath: string;
  providers: readonly string[];
  claude?: Readonly<{
    binaryPath?: string;
    configDirectory?: string;
  }>;
  glm?: Readonly<{
    apiKeyEnvironment?: string;
    environmentFile?: string;
    baseUrl?: string;
  }>;
}>;

export = defineModule<AgentMainConfig>({
  id: "agent.main",
  inject: [
    "application.root",
    "electron.overlay-window",
    "remote.capabilities",
  ],
  provide: ["agent.sessions"],

  async apply(ctx, config) {
    const root = ctx.get<string>("application.root");
    const window = ctx.get<BrowserWindow>("electron.overlay-window");
    const remote = ctx.get<MainRemoteCapabilities>("remote.capabilities");
    const storage = await openNodeStorage({
      directory: path.resolve(root, config.storagePath),
      schema: agentSchema,
      nullableColumnMigrations: [
        { hyos_agent_sessions: ["archivedAt"] },
        {
          hyos_agent_messages: [
            "promptTokens",
            "completionTokens",
            "contextWindow",
          ],
        },
        { hyos_agent_sessions: ["plan"] },
      ],
    });
    const database = await hydb.database({ schema: agentSchema, storage });
    const store = createAgentStore(database);
    const host = createAgentHost({
      window,
      remote,
      store,
      providers: createAgentProviders(config.providers, {
        claude: config.claude,
        glm: config.glm
          ? {
              ...config.glm,
              environmentFile: config.glm.environmentFile
                ? path.resolve(root, config.glm.environmentFile)
                : undefined,
            }
          : undefined,
      }),
    });

    ctx.provide("agent.sessions", host.provider);
    ctx.effect(() => () => database.close());
    ctx.effect(() => remote.provide(agentCapability, host.provider));
    ctx.effect(() => () => host.dispose());
    await host.start();
  },
});
