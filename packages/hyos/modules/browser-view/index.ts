import { createBrowserView } from "./BrowserView.js";
import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "./types.js";

export type { BrowserViewModule, BrowserViewProps } from "./types.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;

registerModule(
  defineModule({
    id: "browser.view",
    inject: ["browser.client"],
    provide: ["browser.view"],

    apply(ctx) {
      const client = ctx.get<BrowserClient>("browser.client");
      ctx.provide<BrowserViewModule>("browser.view", {
        BrowserView: createBrowserView(client),
      });
    },
  }),
);
