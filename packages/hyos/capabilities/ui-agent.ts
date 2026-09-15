import { defineRemoteCapability, remoteMethod } from "./contract.js";

export type UiAgentConnection = Readonly<{ serverUrl: string }>;

export const uiAgentCapability = defineRemoteCapability({
  id: "ui-agent",
  version: 1,
  methods: {
    connection: remoteMethod<readonly [], UiAgentConnection>(),
  },
  events: {},
});
