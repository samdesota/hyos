import { defineRemoteCapability, remoteMethod } from "./contract.js";

/**
 * Window controls for a frameless/titlebar-hidden shell. The renderer invokes
 * these in place of the native macOS traffic-light buttons.
 */
export const windowControlsCapability = defineRemoteCapability({
  id: "window-controls",
  version: 2,
  methods: {
    minimize: remoteMethod<readonly [], void>(),
    toggleMaximize: remoteMethod<readonly [], void>(),
    close: remoteMethod<readonly [], void>(),
    /** macOS only: reveal/hide the native traffic-light buttons. */
    setButtonsVisible: remoteMethod<readonly [boolean], void>(),
  },
  events: {},
});
