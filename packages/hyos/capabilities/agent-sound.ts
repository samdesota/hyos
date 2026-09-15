import {
  defineRemoteCapability,
  remoteEvent,
  remoteMethod,
} from "./contract.js";

/**
 * The agent finish chime: playback lives in the main process (the agent host
 * spawns the platform player on a running → finished transition); the
 * renderer only toggles the preference through this capability.
 */
export const agentSoundCapability = defineRemoteCapability({
  id: "agent.sound",
  version: 1,
  methods: {
    setEnabled: remoteMethod<readonly [enabled: boolean], void>(),
    isEnabled: remoteMethod<readonly [], boolean>(),
  },
  events: {
    /** Published whenever the enabled preference changes. */
    enabled: remoteEvent<boolean>(),
  },
});
