import { defineModule } from "../../runtime.js";
import { createElectronWindows, type ElectronWindowConfig } from "./windows.js";

export = defineModule<ElectronWindowConfig>({
  id: "electron.window",
  inject: ["application.root"],
  provide: ["electron.base-window", "electron.ui-view"],

  apply(ctx, config) {
    const root = ctx.get<string>("application.root");
    const { baseWindow, uiView, alignUi } = createElectronWindows(root, config);

    ctx.provide("electron.base-window", baseWindow);
    ctx.provide("electron.ui-view", uiView);
    ctx.effect(() => {
      baseWindow.on("resize", alignUi);
      return () => {
        baseWindow.off("resize", alignUi);
      };
    });
    ctx.effect(() => () => {
      if (!uiView.webContents.isDestroyed()) uiView.webContents.close();
      if (!baseWindow.isDestroyed()) baseWindow.destroy();
    });
  },
});
