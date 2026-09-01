import { defineModule } from "../../runtime.js";
import { createElectronWindows, type ElectronWindowConfig } from "./windows.js";

export = defineModule<ElectronWindowConfig>({
  id: "electron.window",
  inject: ["application.root"],
  provide: ["electron.base-window", "electron.overlay-window"],

  apply(ctx, config) {
    const root = ctx.get<string>("application.root");
    const { baseWindow, overlayWindow, alignOverlay } = createElectronWindows(
      root,
      config,
    );

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
  },
});
