import { defineModule } from "../../runtime.js";
import { attachViewConsoleLogging, type LogSink } from "../log-main/sink.js";
import { createElectronWindows, type ElectronWindowConfig } from "./windows.js";

export = defineModule<ElectronWindowConfig>({
  id: "electron.window",
  inject: ["application.root", "log.sink"],
  provide: ["electron.base-window", "electron.ui-view"],

  apply(ctx, config) {
    const root = ctx.get<string>("application.root");
    const sink = ctx.get<LogSink>("log.sink");
    const { baseWindow, uiView, alignUi } = createElectronWindows(root, config);
    // Hyos-owned UI view only; browser tab views are never routed to the sink.
    ctx.effect(() =>
      attachViewConsoleLogging(sink, uiView.webContents, "ui-view"),
    );

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
