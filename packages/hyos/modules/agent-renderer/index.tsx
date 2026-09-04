import { render } from "solid-js/web";

import type { RendererRemoteCapabilities } from "../../remote-capabilities.js";
import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "../browser-view/types.js";
import { AgentApp } from "./AgentApp.js";
import { createAgentClient } from "./client.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;

registerModule(
  defineModule({
    id: "agent.renderer",
    inject: [
      "dom.root",
      "remote.capabilities",
      "browser.client",
      "browser.view",
    ],
    provide: ["agent.ui"],

    apply(ctx) {
      const root = ctx.get<Document>("dom.root");
      const remote = ctx.get<RendererRemoteCapabilities>("remote.capabilities");
      const browserClient = ctx.get<BrowserClient>("browser.client");
      const { BrowserView } = ctx.get<BrowserViewModule>("browser.view");
      const mount = root.querySelector<HTMLElement>("#app");
      if (!mount) throw new Error("Missing Solid application mount");
      const client = createAgentClient(remote);
      const dispose = render(
        () => (
          <AgentApp
            root={root}
            client={client}
            browserClient={browserClient}
            BrowserView={BrowserView}
          />
        ),
        mount,
      );

      ctx.provide("agent.ui", { client });
      ctx.effect(() => () => client.dispose());
      ctx.effect(() => dispose);
    },
  }),
);
