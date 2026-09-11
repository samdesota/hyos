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
      id: "reload.main",
      file: "./modules/reload-main/index.ts",
      host: "main",
      reload: "restart",
    },
    {
      id: "keybinding.main",
      file: "./modules/keybinding-main/index.ts",
      host: "main",
      reload: "hot",
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
      id: "whiteboard.main",
      file: "./modules/whiteboard/main/index.ts",
      host: "main",
      reload: "hot",
      config: {
        storagePath: ".data/whiteboard",
      },
    },
    {
      id: "browser.remote-client",
      file: "./modules/browser-client/index.ts",
      host: "renderer",
      reload: "hot",
    },
    {
      id: "browser.view",
      file: "./modules/browser-view/index.ts",
      host: "renderer",
      reload: "hot",
    },
    {
      id: "agent.renderer",
      file: "./modules/agent-renderer/index.tsx",
      host: "renderer",
      reload: "hot",
    },
    {
      id: "browser.main",
      file: "./modules/browser-main/index.ts",
      host: "main",
      reload: "hot",
      config: {
        initialUrl: "https://example.com/",
      },
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
      id: "reload.renderer",
      file: "./modules/reload-renderer/index.tsx",
      host: "renderer",
      reload: "hot",
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
