import type { RendererRemoteCapabilities } from "../../../remote-capabilities.js";
import { createWhiteboardClient } from "./client.js";
import { whiteboardStyles } from "./styles.js";
import type { WhiteboardViewModule } from "./types.js";
import { createWhiteboardPage } from "./WhiteboardPage.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;

registerModule(
  defineModule({
    id: "whiteboard.renderer",
    inject: ["dom.root", "remote.capabilities"],
    provide: ["whiteboard.view"],

    apply(ctx) {
      const root = ctx.get<Document>("dom.root");
      const remote = ctx.get<RendererRemoteCapabilities>("remote.capabilities");
      // Whiteboard styling travels with the module: one style element in
      // the document head, removed when the module tears down.
      const style = root.createElement("style");
      style.textContent = whiteboardStyles;
      root.head.appendChild(style);
      const client = createWhiteboardClient(remote);
      ctx.provide<WhiteboardViewModule>("whiteboard.view", {
        WhiteboardPage: createWhiteboardPage(client),
      });
    },
  }),
);
