import { defineRemoteCapability, remoteMethod } from "./contract.js";

/**
 * Window controls for a frameless/titlebar-hidden shell. The renderer invokes
 * these in place of the native macOS traffic-light buttons.
 */
export const windowControlsCapability = defineRemoteCapability({
  id: "window-controls",
  version: 1,
  methods: {
    minimize: remoteMethod<readonly [], void>(),
    toggleMaximize: remoteMethod<readonly [], void>(),
    close: remoteMethod<readonly [], void>(),
  },
  events: {},
});
