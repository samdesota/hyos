import type { BrowserWindow } from "electron";
import type {
  BrowserBounds,
  BrowserPresentation,
  PresentationId,
  TabId,
} from "../../capabilities/browser.js";
import type { Tab } from "./types.js";

export class BrowserPresentations {
  readonly presentations = new Map<PresentationId, BrowserPresentation>();

  constructor(
    private readonly baseWindow: BrowserWindow,
    private readonly tabs: Map<TabId, Tab>,
  ) {}

  visibleBounds(): BrowserBounds[] {
    return [...this.presentations.values()]
      .filter(({ visible }) => visible)
      .map(({ bounds }) => bounds);
  }

  present(presentation: BrowserPresentation): void {
    const tab = this.tabs.get(presentation.tabId);
    if (!tab) throw new Error(`Unknown browser tab: ${presentation.tabId}`);
    for (const [id, existing] of this.presentations) {
      if (
        id !== presentation.presentationId &&
        existing.tabId === presentation.tabId
      ) {
        this.presentations.delete(id);
      }
    }
    const previous = this.presentations.get(presentation.presentationId);
    if (previous && previous.tabId !== presentation.tabId) {
      const previousTab = this.tabs.get(previous.tabId);
      if (previousTab) this.detach(previousTab);
    }
    this.presentations.set(presentation.presentationId, presentation);
    if (presentation.visible) this.attach(tab, presentation.bounds);
    else this.detach(tab);
  }

  release(presentationId: PresentationId): void {
    const presentation = this.presentations.get(presentationId);
    if (!presentation) return;
    this.presentations.delete(presentationId);
    const tab = this.tabs.get(presentation.tabId);
    if (tab) this.detach(tab);
  }

  removeTab(tab: Tab): void {
    for (const [id, presentation] of this.presentations) {
      if (presentation.tabId === tab.id) this.presentations.delete(id);
    }
    this.detach(tab);
  }

  private detach(tab: Tab): void {
    if (!tab.attached || this.baseWindow.isDestroyed()) return;
    this.baseWindow.contentView.removeChildView(tab.view);
    tab.attached = false;
  }

  private attach(tab: Tab, bounds: BrowserBounds): void {
    if (!tab.attached) {
      this.baseWindow.contentView.addChildView(tab.view);
      tab.attached = true;
    }
    const [windowWidth, windowHeight] = this.baseWindow.getContentSize();
    const x = Math.max(0, Math.round(bounds.x));
    const y = Math.max(0, Math.round(bounds.y));
    tab.view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(Math.round(bounds.width), windowWidth - x)),
      height: Math.max(
        0,
        Math.min(Math.round(bounds.height), windowHeight - y),
      ),
    });
  }
}
