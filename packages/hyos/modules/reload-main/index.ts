import { watch } from "node:fs";
import { defineModule } from "../../runtime.js";
import type { MainRemoteCapabilities } from "../../remote-capabilities.js";
import { reloadCapability } from "../../capabilities/reload.js";
import { createReloadController } from "./controller.js";

export = defineModule({
  id: "reload.main",
  inject: ["application.root", "application.reload", "remote.capabilities"],
  provide: ["reload.control"],
  apply(ctx) {
    const remote = ctx.get<MainRemoteCapabilities>("remote.capabilities");
    const controller = createReloadController(
      ctx.get<() => Promise<void>>("application.reload"),
      (state) => remote.publish(reloadCapability, "changed", state),
    );
    ctx.provide("reload.control", controller);
    ctx.effect(() => remote.provide(reloadCapability, controller));
    ctx.effect(() => {
      const watcher = watch(
        ctx.get<string>("application.root"),
        { recursive: true },
        (_event, filename) => {
          if (filename) controller.changed(String(filename));
        },
      );
      return () => watcher.close();
    });
  },
});
