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
        title: "HyOS Browser Prototype",
        width: 1120,
        height: 760,
      },
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
      id: "browser.renderer",
      file: "./modules/browser-ui/index.tsx",
      host: "renderer",
      reload: "hot",
    },
  ],
});

export default applicationManifest;
