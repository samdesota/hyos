import { onCleanup, type Component } from "solid-js";
import type {
  BrowserBounds,
  PresentationId,
  TabId,
} from "../../capabilities/browser.js";
import type { BrowserClient } from "../browser-client/types.js";
import { boundsOf, isElementVisible, sameBounds } from "./geometry.js";
import type { BrowserViewProps } from "./types.js";

let nextPresentationId = 1;

export function createBrowserView(
  client: BrowserClient,
): Component<BrowserViewProps> {
  return (props) => {
    const presentationId =
      `presentation-${Date.now()}-${nextPresentationId++}` as PresentationId;
    let element!: HTMLDivElement;
    let frame = 0;
    let previousBounds: BrowserBounds | undefined;
    let previousTabId: TabId | undefined;
    let previousVisible: boolean | undefined;
    let previousOverlayRegions: BrowserBounds[] = [];

    const measure = (): void => {
      const bounds = boundsOf(element);
      const visible =
        props.enabled !== false && isElementVisible(element, bounds);
      if (
        !previousBounds ||
        !sameBounds(previousBounds, bounds) ||
        previousTabId !== props.tabId ||
        previousVisible !== visible
      ) {
        previousBounds = bounds;
        previousTabId = props.tabId;
        previousVisible = visible;
        void client.present({
          presentationId,
          tabId: props.tabId,
          bounds,
          visible,
        });
      }

      const overlayRegions = Array.from(
        document.querySelectorAll<HTMLElement>("[data-browser-overlay]"),
      ).map(boundsOf);
      const overlaysChanged =
        overlayRegions.length !== previousOverlayRegions.length ||
        overlayRegions.some(
          (overlayBounds, index) =>
            !sameBounds(overlayBounds, previousOverlayRegions[index]!),
        );
      if (overlaysChanged) {
        previousOverlayRegions = overlayRegions;
        void client.setOverlayRegions(overlayRegions);
      }
      frame = requestAnimationFrame(measure);
    };

    queueMicrotask(() => {
      if (element.isConnected) frame = requestAnimationFrame(measure);
    });
    onCleanup(() => {
      cancelAnimationFrame(frame);
      void client.release(presentationId);
    });

    return (
      <div ref={element} class={props.class} style={props.style}>
        {props.children}
      </div>
    );
  };
}
