import { render } from "solid-js/web";
import type { BrowserClient } from "../browser-client/types.js";
import type { BrowserViewModule } from "../browser-view/types.js";
import { BrowserApp, type ModuleControls } from "./BrowserApp.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;

registerModule(
  defineModule({
    id: "browser.renderer",
    inject: [
      "dom.root",
      "browser.client",
      "browser.view",
      "application.modules",
    ],
    provide: ["browser.ui"],

    apply(ctx) {
      const root = ctx.get<Document>("dom.root");
      const client = ctx.get<BrowserClient>("browser.client");
      const { BrowserView } = ctx.get<BrowserViewModule>("browser.view");
      const modules = ctx.get<ModuleControls>("application.modules");
      const mount = root.querySelector<HTMLElement>("#app");
      if (!mount) throw new Error("Missing Solid application mount");

      const dispose = render(
        () => (
          <BrowserApp
            root={root}
            client={client}
            BrowserView={BrowserView}
            modules={modules}
          />
        ),
        mount,
      );
      ctx.provide("browser.ui", { BrowserView });
      ctx.effect(() => dispose);
    },
  }),
);
