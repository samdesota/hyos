import path from "node:path";
import { BrowserWindow } from "electron";
import { defineModule } from "../runtime.js";
import { remoteChannels } from "../remote-capabilities.js";

type ElectronWindowConfig = Readonly<{
  title: string;
  width: number;
  height: number;
}>;

export = defineModule<ElectronWindowConfig>({
  id: "electron.window",
  inject: ["application.root"],
  provide: ["electron.base-window", "electron.overlay-window"],

  apply(ctx, config) {
    const root = ctx.get<string>("application.root");
    const baseWindow = new BrowserWindow({
      width: config.width,
      height: config.height,
      minWidth: 720,
      minHeight: 520,
      title: config.title,
      backgroundColor: "#f5f2ec",
    });
    const overlayWindow = new BrowserWindow({
      ...baseWindow.getContentBounds(),
      parent: baseWindow,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(root, "preload.js"),
        additionalArguments: [
          `--remote-invoke-channel=${remoteChannels.invoke}`,
          `--remote-event-channel=${remoteChannels.event}`,
        ],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const alignOverlay = (): void => {
      if (baseWindow.isDestroyed() || overlayWindow.isDestroyed()) return;
      overlayWindow.setBounds(baseWindow.getContentBounds());
    };

    ctx.provide("electron.base-window", baseWindow);
    ctx.provide("electron.overlay-window", overlayWindow);
    ctx.effect(() => {
      baseWindow.on("move", alignOverlay);
      baseWindow.on("resize", alignOverlay);
      baseWindow.on("show", alignOverlay);
      return () => {
        baseWindow.off("move", alignOverlay);
        baseWindow.off("resize", alignOverlay);
        baseWindow.off("show", alignOverlay);
      };
    });
    ctx.effect(() => () => {
      if (!overlayWindow.isDestroyed()) overlayWindow.destroy();
      if (!baseWindow.isDestroyed()) baseWindow.destroy();
    });
    void baseWindow.loadFile(path.join(root, "renderer/base.html"));
    void overlayWindow.loadFile(path.join(root, "renderer/index.html"));
    overlayWindow.once("ready-to-show", () => {
      alignOverlay();
      overlayWindow.show();
    });
  },
});
