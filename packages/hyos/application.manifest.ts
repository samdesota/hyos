import { defineApplicationManifest } from "./manifest-contract.js";

export const applicationManifest = defineApplicationManifest({
  version: 1,
  modules: [
    {
      id: "electron.window",
      file: "./modules/electron-window/index.ts",
      host: "main",
      reload: "restart",
      config: {
        title: "HyOS Agent",
        width: 1120,
        height: 760,
        rendererSurface: "base",
      },
    },
    {
      id: "agent.main",
      file: "./modules/agent-main/index.ts",
      host: "main",
      reload: "hot",
      config: {
        storagePath: ".data/agent",
        providers: ["glm", "codex", "claude"],
        glm: {
          apiKeyEnvironment: "AI_GATEWAY_API_KEY",
          environmentFile: "../../.env",
          baseUrl: "https://ai-gateway.vercel.sh/v1",
        },
        claude: {
          binaryPath: "claude",
        },
      },
    },
    {
      id: "agent.renderer",
      file: "./modules/agent-renderer/index.tsx",
      host: "renderer",
      reload: "hot",
    },
    {
      id: "ui-agent.main",
      file: "./modules/ui-agent-main/index.ts",
      host: "main",
      reload: "hot",
      config: {
        port: 4317,
        projectRoot: "../..",
      },
    },
    {
      id: "ui-agent.renderer",
      file: "./modules/ui-agent-renderer/index.ts",
      host: "renderer",
      reload: "hot",
    },
  ],
});

export default applicationManifest;
