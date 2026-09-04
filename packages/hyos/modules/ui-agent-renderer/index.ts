import { attachHyedit } from "@hyos/hyedit/browser";

import { uiAgentCapability } from "../../capabilities/ui-agent.js";
import type { RendererRemoteCapabilities } from "../../remote-capabilities.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;

registerModule(
  defineModule({
    id: "ui-agent.renderer",
    inject: ["dom.root", "remote.capabilities"],
    provide: ["ui-agent.overlay"],

    async apply(ctx) {
      const root = ctx.get<Document>("dom.root");
      const remote = ctx.get<RendererRemoteCapabilities>("remote.capabilities");
      const connection = await remote
        .consume(uiAgentCapability)
        .call("connection");
      const detach = attachHyedit({
        serverUrl: connection.serverUrl,
        document: root,
        mode: "embedded",
      });

      ctx.provide("ui-agent.overlay", { serverUrl: connection.serverUrl });
      ctx.effect(() => detach);
    },
  }),
);
