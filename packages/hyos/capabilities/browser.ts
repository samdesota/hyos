import {
  defineRemoteCapability,
  remoteEvent,
  remoteMethod,
} from "./contract.js";

export type TabId = `tab-${number}`;
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

export type BrowserPresentation = Readonly<{
  presentationId: PresentationId;
  tabId: TabId;
  bounds: BrowserBounds;
  visible: boolean;
}>;

export const browserCapability = defineRemoteCapability({
  id: "browser",
  version: 2,
  methods: {
    execute: remoteMethod<readonly [command: BrowserCommand], BrowserState>(),
    present: remoteMethod<readonly [presentation: BrowserPresentation], void>(),
    release: remoteMethod<readonly [presentationId: PresentationId], void>(),
    setOverlayRegions: remoteMethod<
      readonly [regions: readonly BrowserBounds[]],
      void
    >(),
  },
  events: {
    state: remoteEvent<BrowserState>(),
  },
});
