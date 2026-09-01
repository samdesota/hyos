import type { RendererRemoteCapabilities } from "../remote-capabilities.js";
import {
  browserCapability,
  type BrowserBounds,
  type BrowserCommand,
  type BrowserPresentation,
  type BrowserState,
  type PresentationId,
} from "../capabilities/browser.js";

export interface BrowserClient {
  readonly protocol: Readonly<{ name: "browser"; version: number }>;
  execute(command: BrowserCommand): Promise<BrowserState>;
  present(presentation: BrowserPresentation): Promise<void>;
  release(presentationId: PresentationId): Promise<void>;
  setOverlayRegions(regions: readonly BrowserBounds[]): Promise<void>;
  subscribe(listener: (state: BrowserState) => void): () => void;
}

const { defineModule, registerModule } = globalThis.PrototypeModules;

registerModule(
  defineModule({
    id: "browser.remote-client",
    inject: ["remote.capabilities"],
    provide: ["browser.client"],

    apply(ctx) {
      const remote = ctx.get<RendererRemoteCapabilities>("remote.capabilities");
      const browser = remote.consume(browserCapability);
      const client: BrowserClient = {
        protocol: { name: browser.id, version: browser.version },
        execute: (command) => browser.call("execute", command),
        present: (presentation) => browser.call("present", presentation),
        release: (presentationId) => browser.call("release", presentationId),
        setOverlayRegions: (regions) =>
          browser.call("setOverlayRegions", regions),
        subscribe: (listener) => browser.subscribe("state", listener),
      };
      ctx.provide("browser.client", client);
    },
  }),
);
