import type { RendererRemoteCapabilities } from "../../remote-capabilities.js";
import { createBrowserClient } from "./client.js";

export type { BrowserClient } from "./types.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;

registerModule(
  defineModule({
    id: "browser.remote-client",
    inject: ["remote.capabilities"],
    provide: ["browser.client"],

    apply(ctx) {
      const remote = ctx.get<RendererRemoteCapabilities>("remote.capabilities");
      ctx.provide("browser.client", createBrowserClient(remote));
    },
  }),
);
