import type { Component, JSX } from "solid-js";
import type { TabId } from "../../capabilities/browser.js";

export interface BrowserViewProps {
  tabId: TabId;
  enabled?: boolean;
  class?: string;
  style?: JSX.CSSProperties | string;
  children?: JSX.Element;
}

export interface BrowserViewModule {
  BrowserView: Component<BrowserViewProps>;
}
