import type { WebContents, WebContentsView } from "electron";
import type { TabId } from "../../capabilities/browser.js";

export type BrowserMainConfig = Readonly<{ initialUrl: string }>;

export type Tab = {
  id: TabId;
  view: WebContentsView;
  contents: WebContents;
  error: string | null;
  attached: boolean;
  disposed: boolean;
  removeListeners: Array<() => void>;
};
