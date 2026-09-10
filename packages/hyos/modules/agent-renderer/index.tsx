import { Route, HashRouter } from "@solidjs/router";
import { render } from "solid-js/web";

import type { RendererRemoteCapabilities } from "../../remote-capabilities.js";
import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "../browser-view/types.js";
import { AgentApp } from "./AgentApp.js";
import { createAgentClient, createKeybindingClient } from "./client.js";

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
      const keybindingClient = createKeybindingClient(remote);
      const dispose = render(
        () => (
          // Hash-mode router shell. Routing is not yet wired into the app;
          // the catch-all route just renders AgentApp exactly as before.
          <HashRouter>
            <Route
              path="*"
              component={() => (
                <AgentApp
                  root={root}
                  client={client}
                  keybindingClient={keybindingClient}
                  browserClient={browserClient}
                  BrowserView={BrowserView}
                />
              )}
            />
          </HashRouter>
        ),
        mount,
      );

      ctx.provide("agent.ui", { client });
      ctx.effect(() => () => client.dispose());
      ctx.effect(() => () => keybindingClient.dispose());
      ctx.effect(() => dispose);
    },
  }),
);
