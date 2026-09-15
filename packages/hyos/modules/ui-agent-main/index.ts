import path from "node:path";

import { uiAgentCapability } from "../../capabilities/ui-agent.js";
import type { MainRemoteCapabilities } from "../../remote-capabilities.js";
import { defineModule } from "../../runtime.js";

type UiAgentMainConfig = Readonly<{
  port?: number;
  projectRoot?: string;
}>;

export = defineModule<UiAgentMainConfig>({
  id: "ui-agent.main",
  inject: ["application.root", "remote.capabilities"],
  provide: ["ui-agent.server"],

  async apply(ctx, config) {
    const { createHyeditServer } = await import("@hyos/hyedit/server");
    const applicationRoot = ctx.get<string>("application.root");
    const remote = ctx.get<MainRemoteCapabilities>("remote.capabilities");
    const smokeTest = process.argv.includes("--smoke-test");
    const server = createHyeditServer({
      // Smoke tests may run beside the interactive app. Let the OS assign a
      // private port so the test never competes with the dev server.
      port: smokeTest ? 0 : (config.port ?? 4317),
      projectRoot: path.resolve(applicationRoot, config.projectRoot ?? "../.."),
    });
    const serverUrl = await server.start();
    const provider = { connection: () => ({ serverUrl }) };

    ctx.provide("ui-agent.server", provider);
    ctx.effect(() => () => server.close());
    ctx.effect(() => remote.provide(uiAgentCapability, provider));
  },
});
