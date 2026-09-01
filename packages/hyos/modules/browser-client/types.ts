import type {
  BrowserBounds,
  BrowserCommand,
  BrowserPresentation,
  BrowserState,
  PresentationId,
} from "../../capabilities/browser.js";

export interface BrowserClient {
  readonly protocol: Readonly<{ name: "browser"; version: number }>;
  execute(command: BrowserCommand): Promise<BrowserState>;
  present(presentation: BrowserPresentation): Promise<void>;
  release(presentationId: PresentationId): Promise<void>;
  setOverlayRegions(regions: readonly BrowserBounds[]): Promise<void>;
  subscribe(listener: (state: BrowserState) => void): () => void;
}
