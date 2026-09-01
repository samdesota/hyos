import { onCleanup, type Component, type JSX } from "solid-js";
import type {
  BrowserBounds,
  PresentationId,
  TabId,
} from "../capabilities/browser.js";
import type { BrowserClient } from "./browser-client.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;
let nextPresentationId = 1;

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

function boundsOf(element: Element): BrowserBounds {
  const bounds = element.getBoundingClientRect();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function sameBounds(left: BrowserBounds, right: BrowserBounds): boolean {
  return (
    Math.round(left.x) === Math.round(right.x) &&
    Math.round(left.y) === Math.round(right.y) &&
    Math.round(left.width) === Math.round(right.width) &&
    Math.round(left.height) === Math.round(right.height)
  );
}

registerModule(
  defineModule({
    id: "browser.view",
    inject: ["browser.client"],
    provide: ["browser.view"],

    apply(ctx) {
      const client = ctx.get<BrowserClient>("browser.client");

      const BrowserView: Component<BrowserViewProps> = (props) => {
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
          const style = getComputedStyle(element);
          const visible =
            props.enabled !== false &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.x + bounds.width > 0 &&
            bounds.y + bounds.height > 0 &&
            bounds.x < window.innerWidth &&
            bounds.y < window.innerHeight;

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
              (bounds, index) =>
                !sameBounds(bounds, previousOverlayRegions[index]!),
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

      ctx.provide<BrowserViewModule>("browser.view", { BrowserView });
    },
  }),
);
