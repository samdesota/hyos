export const UI_AGENT_FRAME_ID = "hyos-ui-agent-overlay";
export const UI_AGENT_LAUNCHER_ID = "hyos-ui-agent-launcher";
export const UI_AGENT_DISPOSE_EVENT = "hyos-ui-agent:dispose";

export interface SelectionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OverlayMessage =
  | {
      source: "hyos-ui-agent";
      type: "overlay-ready";
    }
  | {
      source: "hyos-ui-agent";
      type: "region-selected";
      region: SelectionRegion;
    }
  | {
      source: "hyos-ui-agent";
      type: "submit-iteration";
      instruction: string;
    }
  | {
      source: "hyos-ui-agent";
      type: "close-overlay";
    };
