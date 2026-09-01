import { defineApplicationManifest } from "./manifest-contract.js";

export const applicationManifest = defineApplicationManifest({
  version: 1,
  modules: [
    {
      id: "electron.window",
      file: "./modules/electron-window.ts",
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
      file: "./modules/browser-main.ts",
      host: "main",
      reload: "hot",
      config: {
        initialUrl: "https://example.com/",
      },
    },
    {
      id: "browser.remote-client",
      file: "./modules/browser-client.ts",
      host: "renderer",
      reload: "hot",
    },
    {
      id: "browser.view",
      file: "./modules/browser-view.tsx",
      host: "renderer",
      reload: "hot",
    },
    {
      id: "browser.renderer",
      file: "./modules/browser-ui.tsx",
      host: "renderer",
      reload: "hot",
    },
  ],
});

export default applicationManifest;
