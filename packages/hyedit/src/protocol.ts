export const HYEDIT_FRAME_ID = "hyedit-overlay";
export const HYEDIT_LAUNCHER_ID = "hyedit-launcher";
export const HYEDIT_DISPOSE_EVENT = "hyedit:dispose";

export interface SelectionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OverlayMessage =
  | {
      source: "hyedit";
      type: "overlay-ready";
    }
  | {
      source: "hyedit";
      type: "region-selected";
      region: SelectionRegion;
    }
  | {
      source: "hyedit";
      type: "submit-iteration";
      instruction: string;
    }
  | {
      source: "hyedit";
      type: "close-overlay";
    };
