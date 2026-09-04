import { render } from "solid-js/web";

import type { RendererRemoteCapabilities } from "../../remote-capabilities.js";
import { AgentApp } from "./AgentApp.js";
import { createAgentClient } from "./client.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;

registerModule(
  defineModule({
    id: "agent.renderer",
    inject: ["dom.root", "remote.capabilities"],
    provide: ["agent.ui"],

    apply(ctx) {
      const root = ctx.get<Document>("dom.root");
      const remote = ctx.get<RendererRemoteCapabilities>("remote.capabilities");
      const mount = root.querySelector<HTMLElement>("#app");
      if (!mount) throw new Error("Missing Solid application mount");
      const client = createAgentClient(remote);
      const dispose = render(
        () => <AgentApp root={root} client={client} />,
        mount,
      );

      ctx.provide("agent.ui", { client });
      ctx.effect(() => () => client.dispose());
      ctx.effect(() => dispose);
    },
  }),
);
