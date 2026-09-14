import path from "node:path";

import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";
import type { BrowserWindow } from "electron";

import { agentCapability } from "../../capabilities/agent.js";
import { agentSoundCapability } from "../../capabilities/agent-sound.js";
import { browserCapability } from "../../capabilities/browser.js";
import type { MainRemoteCapabilities } from "../../remote-capabilities.js";
import { defineModule } from "../../runtime.js";
import { createAgentHost } from "./host.js";
import { agentSchema } from "./model.js";
import { createAgentProviders } from "./providers/index.js";
import { createAgentStore } from "./store.js";
import { createFinishSound } from "./finish-sound.js";
import type { LogSink } from "../log-main/sink.js";

type AgentMainConfig = Readonly<{
  storagePath: string;
  providers: readonly string[];
  codex?: Readonly<{
    authDirectory?: string;
  }>;
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
    "electron.base-window",
    "log.sink",
    "remote.capabilities",
  ],
  provide: ["agent.sessions"],

  async apply(ctx, config) {
    const bootStartedAt = performance.now();
    const BOOT_TRACE = process.env.HYOS_BOOT_TRACE === "1";
    const bootTrace = (event: string) => {
      if (!BOOT_TRACE) return;
      console.log(
        `[DEBUG-boot-7f2c] +${Math.round(performance.now() - bootStartedAt)}ms agent-main ${event}`,
      );
    };
    const root = ctx.get<string>("application.root");
    const window = ctx.get<BrowserWindow>("electron.base-window");
    const remote = ctx.get<MainRemoteCapabilities>("remote.capabilities");
    const browser = remote.consume(browserCapability);
    bootTrace("storage:open:start");
    const storage = await openNodeStorage({
      directory: path.resolve(root, config.storagePath),
      schema: agentSchema,
      addedTableMigrations: [
        [
          "hyos_agent_boards",
          "hyos_agent_board_cards",
          "hyos_agent_board_media",
        ],
        ["hyos_agent_global_tabs"],
      ],
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
        { hyos_agent_sessions: ["tabs"] },
        { hyos_agent_sessions: ["statusDetail"] },
        { hyos_agent_sessions: ["order"] },
        { hyos_agent_sessions: ["seenStatusDetail"] },
      ],
    });
    bootTrace("storage:open:done");
    bootTrace("database:init:start");
    const database = await hydb.database({ schema: agentSchema, storage });
    bootTrace("database:init:done");
    const store = createAgentStore(database);
    const host = createAgentHost({
      window,
      remote,
      browser,
      store,
      providers: createAgentProviders(config.providers, {
        codex: config.codex,
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

    // Finish chime: main-process playback via the platform player, with the
    // enabled preference persisted beside the agent storage.
    const sink = ctx.get<LogSink>("log.sink");
    const finishSound = createFinishSound({
      store,
      storageDirectory: path.resolve(root, config.storagePath),
      assetPath: path.resolve(root, "modules/agent-main/finish.mp3"),
      sink,
    });
    ctx.effect(() =>
      remote.provide(agentSoundCapability, finishSound.provider),
    );
    ctx.effect(() => finishSound.watch());
    ctx.effect(() => () => finishSound.dispose());

    bootTrace("host:start:start");
    await host.start();
    bootTrace("host:start:done");
  },
});
