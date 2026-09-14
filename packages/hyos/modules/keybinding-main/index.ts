import {
  app,
  type Event as ElectronEvent,
  type WebContents,
  type WebContentsView,
} from "electron";

import {
  keybindingCapability,
  type KeybindingAccelerator,
} from "../../capabilities/keybinding.js";
import type { MainRemoteCapabilities } from "../../remote-capabilities.js";
import { defineModule } from "../../runtime.js";

/**
 * A parsed Electron accelerator: modifier flags resolved for the current
 * platform ("CmdOrCtrl" becomes Meta on macOS, Control elsewhere) plus the
 * normalized key name.
 */
type ParsedAccelerator = Readonly<{
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}>;

type KeybindingControl = Readonly<{
  register(binding: {
    readonly action: string;
    readonly accelerator: KeybindingAccelerator;
  }): void;
  unregister(action: string): void;
}>;

type Modifier = "meta" | "ctrl" | "shift" | "alt" | "metaOrCtrl";

const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  command: "meta",
  cmd: "meta",
  super: "meta",
  meta: "meta",
  control: "ctrl",
  ctrl: "ctrl",
  commandorcontrol: "metaOrCtrl",
  cmdorctrl: "metaOrCtrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  optionalt: "alt",
};

function parseAccelerator(
  accelerator: KeybindingAccelerator,
): ParsedAccelerator {
  const parsed = {
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
    key: "",
  };
  for (const part of accelerator.split("+")) {
    const alias = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (alias === "metaOrCtrl") {
      if (process.platform === "darwin") parsed.meta = true;
      else parsed.ctrl = true;
    } else if (alias) {
      parsed[alias] = true;
    } else if (parsed.key) {
      throw new Error(`Invalid keybinding accelerator: ${accelerator}`);
    } else {
      parsed.key = part.trim().toLowerCase();
    }
  }
  if (!parsed.key)
    throw new Error(`Invalid keybinding accelerator: ${accelerator}`);
  return parsed;
}

function matchesAccelerator(
  parsed: ParsedAccelerator,
  input: Electron.Input,
): boolean {
  return (
    parsed.meta === input.meta &&
    parsed.ctrl === input.control &&
    parsed.shift === input.shift &&
    parsed.alt === input.alt &&
    parsed.key === input.key.toLowerCase()
  );
}

export = defineModule({
  id: "keybinding.main",
  inject: ["electron.ui-view", "remote.capabilities"],
  provide: ["keybinding.control"],

  apply(ctx) {
    const uiView = ctx.get<WebContentsView>("electron.ui-view");
    const remote = ctx.get<MainRemoteCapabilities>("remote.capabilities");

    const bindings = new Map<string, ParsedAccelerator>();
    const attached = new Map<number, WebContents>();

    // Match registered accelerators against raw key events before the page
    // sees them, so the shortcut works no matter which pane (agent renderer
    // or an embedded browser tab) has keyboard focus.
    const onBeforeInput = (
      event: ElectronEvent,
      input: Electron.Input,
    ): void => {
      if (input.type !== "keyDown") return;
      for (const [action, parsed] of bindings) {
        if (matchesAccelerator(parsed, input)) {
          event.preventDefault();
          remote.publish(keybindingCapability, "triggered", { action });
          return;
        }
      }
    };

    const attach = (contents: WebContents): void => {
      if (contents.isDestroyed() || attached.has(contents.id)) return;
      attached.set(contents.id, contents);
      contents.on("before-input-event", onBeforeInput);
    };

    attach(uiView.webContents);
    // Browser tabs are WebContentsViews created (and destroyed) on demand;
    // catch every new webContents so their keystrokes are covered too.
    const onWebContentsCreated = (
      _event: Electron.Event,
      contents: WebContents,
    ): void => attach(contents);
    app.on("web-contents-created", onWebContentsCreated);

    const control: KeybindingControl = {
      register({ action, accelerator }) {
        bindings.set(action, parseAccelerator(accelerator));
      },
      unregister(action) {
        bindings.delete(action);
      },
    };

    ctx.provide("keybinding.control", control);
    ctx.effect(() => remote.provide(keybindingCapability, control));
    ctx.effect(() => () => {
      app.off("web-contents-created", onWebContentsCreated);
      for (const contents of attached.values()) {
        if (!contents.isDestroyed())
          contents.removeListener("before-input-event", onBeforeInput);
      }
      attached.clear();
      bindings.clear();
    });
  },
});
