import type { ElementSelection, QuickIterationResult } from "../agent-types.js";

export interface SelectionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotCapture {
  dataUrl: string;
  width: number;
  height: number;
}

export interface RestoredIteration {
  context: {
    region: SelectionRegion;
    elements: ElementSelection[];
    screenshot?: ScreenshotCapture;
  };
  instruction: string;
  model?: string;
  requestId: string;
  status: "submitting" | "result" | "undoing" | "undone";
  result?: QuickIterationResult;
}

export type HostToOverlayMessage =
  | { source: "hyos-ui-agent-host"; type: "start-region-selection" }
  | { source: "hyos-ui-agent-host"; type: "cancel-overlay" }
  | {
      source: "hyos-ui-agent-host";
      type: "restore-iteration";
      iteration: RestoredIteration;
    }
  | {
      source: "hyos-ui-agent-host";
      type: "selection-context-ready";
      region: SelectionRegion;
      elements: ElementSelection[];
      screenshot?: ScreenshotCapture;
      captureError?: string;
    }
  | {
      source: "hyos-ui-agent-host";
      type: "iteration-complete";
      result: QuickIterationResult;
    }
  | {
      source: "hyos-ui-agent-host";
      type: "iteration-error";
      message: string;
    }
  | { source: "hyos-ui-agent-host"; type: "iteration-undone" }
  | {
      source: "hyos-ui-agent-host";
      type: "undo-error";
      message: string;
    };

export type OverlayToHostMessage =
  | { source: "hyos-ui-agent"; type: "overlay-ready" }
  | {
      source: "hyos-ui-agent";
      type: "region-selected";
      region: SelectionRegion;
    }
  | {
      source: "hyos-ui-agent";
      type: "submit-iteration";
      instruction: string;
      requestId: string;
      model: string;
    }
  | { source: "hyos-ui-agent"; type: "undo-iteration"; id: string }
  | { source: "hyos-ui-agent"; type: "close-overlay" };

export type HostMessagePayload = HostToOverlayMessage extends infer Message
  ? Message extends { source: "hyos-ui-agent-host" }
    ? Omit<Message, "source">
    : never
  : never;

export type OverlayMessagePayload = OverlayToHostMessage extends infer Message
  ? Message extends { source: "hyos-ui-agent" }
    ? Omit<Message, "source">
    : never
  : never;
