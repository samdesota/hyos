import {
  defineRemoteCapability,
  remoteEvent,
  remoteMethod,
} from "./contract.js";

export type ReloadState = Readonly<{
  pending: boolean;
  reloading: boolean;
  error: string | null;
}>;
export const reloadCapability = defineRemoteCapability({
  id: "reload",
  version: 1,
  methods: {
    state: remoteMethod<readonly [], ReloadState>(),
    reload: remoteMethod<readonly [], void>(),
  },
  events: { changed: remoteEvent<ReloadState>() },
});
