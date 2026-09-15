import {
  defineRemoteCapability,
  remoteEvent,
  remoteMethod,
} from "./contract.js";

// Tab ids are UUIDs minted by the browser host: unique across host reloads
// and restarts, so a persisted tabId can be re-adopted without ambiguity.
export type TabId = string;
export type PresentationId = `presentation-${string}`;

export type BrowserBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type BrowserCommand =
  | { type: "snapshot" }
  | { type: "create-tab"; url?: string }
  | { type: "activate-tab"; tabId: TabId }
  | { type: "close-tab"; tabId: TabId }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" };

export type BrowserTabState = Readonly<{
  id: TabId;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}>;

export type BrowserState = Readonly<{
  generation: number;
  sequence: number;
  activeTabId: TabId | null;
  tabs: readonly BrowserTabState[];
}>;

/**
 * A Chrome DevTools Protocol endpoint to discover targets on, e.g. a Chrome
 * launched with `--remote-debugging-port=9333` or HyOS itself via
 * `HYOS_DEVTOOLS_PORT`.
 */
export type CdpEndpoint = Readonly<{ host: string; port: number }>;

/** One discoverable target from `GET /json/list` on a CDP endpoint. */
export type CdpTarget = Readonly<{
  id: string;
  type: string;
  title: string;
  url: string;
  devtoolsFrontendUrl: string | null;
  webSocketDebuggerUrl: string | null;
}>;

/** The CDP endpoint inspect affordances default to: HyOS-style debug port. */
export const defaultCdpEndpoint: CdpEndpoint = {
  host: "localhost",
  port: 9333,
};

/**
 * Parse a user- or agent-supplied endpoint reference — `host:port`, bare
 * `:port`, or an `http(s)://host:port` origin — into a CDP endpoint. Null
 * when the text names no usable host/port.
 */
export function parseCdpEndpoint(text: string): CdpEndpoint | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port <= 0) return null;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

/** A request to open one discovered target's devtools frontend as a tab. */
export type CdpTargetRequest = Readonly<{
  endpoint: CdpEndpoint;
  targetId: string;
}>;

/** The browser tab opened for a CDP target, plus the target it shows. */
export type CdpTargetOpen = Readonly<{
  tabId: TabId;
  target: CdpTarget;
}>;

export type BrowserPresentation = Readonly<{
  presentationId: PresentationId;
  tabId: TabId;
  bounds: BrowserBounds;
  visible: boolean;
}>;

export const browserCapability = defineRemoteCapability({
  id: "browser",
  version: 5,
  methods: {
    execute: remoteMethod<readonly [command: BrowserCommand], BrowserState>(),
    inspectCdp: remoteMethod<
      readonly [endpoint: CdpEndpoint],
      readonly CdpTarget[]
    >(),
    openCdpTarget: remoteMethod<
      readonly [request: CdpTargetRequest],
      CdpTargetOpen
    >(),
    present: remoteMethod<readonly [presentation: BrowserPresentation], void>(),
    release: remoteMethod<readonly [presentationId: PresentationId], void>(),
    setOverlayRegions: remoteMethod<
      readonly [regions: readonly BrowserBounds[]],
      void
    >(),
    setModalOverlay: remoteMethod<readonly [active: boolean], void>(),
  },
  events: {
    state: remoteEvent<BrowserState>(),
  },
});
