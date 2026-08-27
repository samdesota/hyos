export const UI_AGENT_FRAME_ID = "hyos-ui-agent-overlay";

export type OverlayMessage =
  | {
      source: "hyos-ui-agent";
      type: "overlay-ready";
    }
  | {
      source: "hyos-ui-agent";
      type: "set-pointer-events";
      enabled: boolean;
    };
