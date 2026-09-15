import { defineModule } from "../../runtime.js";
import type { MainRemoteCapabilities } from "../../remote-capabilities.js";
import { windowControlsCapability } from "../../capabilities/window-controls.js";
import { attachViewConsoleLogging, type LogSink } from "../log-main/sink.js";
import {
  createElectronWindows,
  windowControlsImplementation,
  type ElectronWindowConfig,
} from "./windows.js";

export = defineModule<ElectronWindowConfig>({
  id: "electron.window",
  inject: ["application.root", "log.sink", "remote.capabilities"],
  provide: ["electron.base-window", "electron.ui-view"],

  apply(ctx, config) {
    const root = ctx.get<string>("application.root");
    const sink = ctx.get<LogSink>("log.sink");
    const remote = ctx.get<MainRemoteCapabilities>("remote.capabilities");
    const { baseWindow, uiView, alignUi } = createElectronWindows(root, config);
    // Hyos-owned UI view only; browser tab views are never routed to the sink.
    ctx.effect(() =>
      attachViewConsoleLogging(sink, uiView.webContents, "ui-view"),
    );

    ctx.provide("electron.base-window", baseWindow);
    ctx.provide("electron.ui-view", uiView);
    // Renderer-invoked window controls (Arc-style traffic lights).
    ctx.effect(() =>
      remote.provide(
        windowControlsCapability,
        windowControlsImplementation(baseWindow),
      ),
    );
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
