import {
  browserCapability,
  type BrowserCommand,
  type BrowserPresentation,
  type PresentationId,
} from "../../capabilities/browser.js";
import type {
  RemoteConsumer,
  RendererRemoteCapabilities,
} from "../../remote-capabilities.js";
import type { BrowserClient } from "./types.js";

export function createBrowserClient(
  remote: RendererRemoteCapabilities,
): BrowserClient {
  const browser: RemoteConsumer<typeof browserCapability> =
    remote.consume(browserCapability);
  return {
    protocol: { name: browser.id, version: browser.version },
    execute: (command: BrowserCommand) => browser.call("execute", command),
    present: (presentation: BrowserPresentation) =>
      browser.call("present", presentation),
    release: (presentationId: PresentationId) =>
      browser.call("release", presentationId),
    setOverlayRegions: (regions) => browser.call("setOverlayRegions", regions),
    subscribe: (listener) => browser.subscribe("state", listener),
  };
}
