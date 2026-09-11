import { Route, HashRouter } from "@solidjs/router";
import { render } from "solid-js/web";

import type { RendererRemoteCapabilities } from "../../remote-capabilities.js";
import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "../browser-view/types.js";
import { AgentApp } from "./AgentApp.js";
import { createAgentClient, createKeybindingClient } from "./client.js";
import { ROUTE_PATHS } from "./session-route.js";

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
          // Hash-mode router shell. Routes mirror the AppRoute model
          // (`/`, `/session/:id`, `/tabs/:id`); the URL is authoritative —
          // AgentApp derives its open view from the matched route.
          <HashRouter
            root={() => (
              <AgentApp
                root={root}
                client={client}
                keybindingClient={keybindingClient}
                browserClient={browserClient}
                BrowserView={BrowserView}
              />
            )}
          >
            <Route path={ROUTE_PATHS.new} />
            <Route path={ROUTE_PATHS.session} />
            <Route path={ROUTE_PATHS.globalTabs} />
            {/* Unrecognized hashes land here and read as `/`. */}
            <Route path="*" />
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
