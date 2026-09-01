import type { BrowserWindow } from "electron";
import { browserCapability } from "../../capabilities/browser.js";
import type { MainRemoteCapabilities } from "../../remote-capabilities.js";
import { defineModule } from "../../runtime.js";
import { createBrowserHost } from "./host.js";
import type { BrowserMainConfig } from "./types.js";

export = defineModule<BrowserMainConfig>({
  id: "browser.main",
  inject: [
    "electron.base-window",
    "electron.overlay-window",
    "remote.capabilities",
  ],
  provide: ["browser.host"],

  apply(ctx, config) {
    const baseWindow = ctx.get<BrowserWindow>("electron.base-window");
    const overlayWindow = ctx.get<BrowserWindow>("electron.overlay-window");
    const remote = ctx.get<MainRemoteCapabilities>("remote.capabilities");
    const host = createBrowserHost(baseWindow, overlayWindow, remote, config);

    ctx.provide("browser.host", host.provider);
    ctx.effect(() => remote.provide(browserCapability, host.provider));
    ctx.effect(() => () => host.dispose());
    host.start();
  },
});
