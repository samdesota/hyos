import type {
  BrowserBounds,
  BrowserCommand,
  BrowserPresentation,
  BrowserState,
  CdpEndpoint,
  CdpTarget,
  CdpTargetOpen,
  CdpTargetRequest,
  PresentationId,
} from "../../capabilities/browser.js";

export interface BrowserClient {
  readonly protocol: Readonly<{ name: "browser"; version: number }>;
  execute(command: BrowserCommand): Promise<BrowserState>;
  /** Discover CDP debug targets on an endpoint (`GET /json/list`). */
  inspectCdp(endpoint: CdpEndpoint): Promise<readonly CdpTarget[]>;
  /** Open one discovered target's devtools frontend as a browser tab. */
  openCdpTarget(request: CdpTargetRequest): Promise<CdpTargetOpen>;
  present(presentation: BrowserPresentation): Promise<void>;
  release(presentationId: PresentationId): Promise<void>;
  setOverlayRegions(regions: readonly BrowserBounds[]): Promise<void>;
  setModalOverlay(active: boolean): Promise<void>;
  subscribe(listener: (state: BrowserState) => void): () => void;
}
