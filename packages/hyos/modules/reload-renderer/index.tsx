import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import {
  reloadCapability,
  type ReloadState,
} from "../../capabilities/reload.js";
import type { RendererRemoteCapabilities } from "../../remote-capabilities.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;
registerModule(
  defineModule({
    id: "reload.renderer",
    inject: ["dom.root", "remote.capabilities"],
    provide: [],
    apply(ctx) {
      const document = ctx.get<Document>("dom.root");
      const remote = ctx
        .get<RendererRemoteCapabilities>("remote.capabilities")
        .consume(reloadCapability);
      const [state, setState] = createSignal<ReloadState>({
        pending: false,
        reloading: false,
        error: null,
      });
      let disposed = false;
      let received = false;
      ctx.effect(() =>
        remote.subscribe("changed", (value) => {
          received = true;
          setState(value);
        }),
      );
      void remote
        .call("state")
        .then((value) => {
          if (!disposed && !received) setState(value);
        })
        .catch(() => {});
      ctx.effect(() => () => {
        disposed = true;
      });
      const triggerReload = () => {
        void remote.call("reload").catch((error) =>
          setState({
            pending: true,
            reloading: false,
            error: String(error),
          }),
        );
      };
      ctx.effect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
          if (
            event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            event.key.toLowerCase() === "r"
          ) {
            event.preventDefault();
            triggerReload();
          }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
      });
      ctx.effect(() => {
        const mount = document.createElement("div");
        document.body.append(mount);
        const dispose = render(
          () => (
            <Show when={state().pending || state().reloading}>
              <button
                style={{
                  position: "fixed",
                  top: "3px",
                  right: "12px",
                  "z-index": 10000,
                  "font-size": "11px",
                  "border-radius": "8px",
                  border: "1px solid #647c45",
                  background: "#303c24",
                  color: "#d5ebad",
                  cursor: "pointer",
                  "-webkit-app-region": "no-drag",
                }}
                disabled={state().reloading}
                title={
                  state().error ??
                  "Reload modules. Active agent runs will be interrupted. Shell changes require an app restart."
                }
                onClick={triggerReload}
              >
                {state().reloading
                  ? "Reloading…"
                  : state().error
                    ? "Reload failed · retry"
                    : "Reload changes"}
              </button>
            </Show>
          ),
          mount,
        );
        return () => {
          dispose();
          mount.remove();
        };
      });
    },
  }),
);
