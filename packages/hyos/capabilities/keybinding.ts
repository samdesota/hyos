import {
  defineRemoteCapability,
  remoteEvent,
  remoteMethod,
} from "./contract.js";

/**
 * An action id declared by consumers (e.g. "create.open") that a registered
 * accelerator triggers. Accelerators use Electron accelerator syntax, e.g.
 * "CmdOrCtrl+T".
 */
export type KeybindingAction = string;
export type KeybindingAccelerator = string;

export const keybindingCapability = defineRemoteCapability({
  id: "keybinding",
  version: 1,
  methods: {
    register: remoteMethod<
      readonly [
        Readonly<{
          action: KeybindingAction;
          accelerator: KeybindingAccelerator;
        }>,
      ],
      void
    >(),
    unregister: remoteMethod<readonly [KeybindingAction], void>(),
  },
  events: {
    triggered: remoteEvent<Readonly<{ action: KeybindingAction }>>(),
  },
});
