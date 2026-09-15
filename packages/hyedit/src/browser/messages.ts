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
  | { source: "hyedit-host"; type: "start-region-selection" }
  | { source: "hyedit-host"; type: "cancel-overlay" }
  | {
      source: "hyedit-host";
      type: "restore-iteration";
      iteration: RestoredIteration;
    }
  | {
      source: "hyedit-host";
      type: "selection-context-ready";
      region: SelectionRegion;
      elements: ElementSelection[];
      screenshot?: ScreenshotCapture;
      captureError?: string;
    }
  | {
      source: "hyedit-host";
      type: "iteration-complete";
      result: QuickIterationResult;
    }
  | {
      source: "hyedit-host";
      type: "iteration-error";
      message: string;
    }
  | { source: "hyedit-host"; type: "iteration-undone" }
  | {
      source: "hyedit-host";
      type: "undo-error";
      message: string;
    };

export type OverlayToHostMessage =
  | { source: "hyedit"; type: "overlay-ready" }
  | {
      source: "hyedit";
      type: "region-selected";
      region: SelectionRegion;
    }
  | {
      source: "hyedit";
      type: "submit-iteration";
      instruction: string;
      requestId: string;
      model: string;
    }
  | { source: "hyedit"; type: "undo-iteration"; id: string }
  | { source: "hyedit"; type: "close-overlay" };

export type HostMessagePayload = HostToOverlayMessage extends infer Message
  ? Message extends { source: "hyedit-host" }
    ? Omit<Message, "source">
    : never
  : never;

export type OverlayMessagePayload = OverlayToHostMessage extends infer Message
  ? Message extends { source: "hyedit" }
    ? Omit<Message, "source">
    : never
  : never;
