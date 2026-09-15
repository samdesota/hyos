import { For, Show, createSignal, type Component, type JSX } from "solid-js";

import type { CdpTarget } from "../../capabilities/browser.js";
import { defaultCdpEndpoint } from "../../capabilities/browser.js";
import type { AppState } from "./app-state.js";
import { Popover } from "./Popover.js";

const defaultEndpointText = `${defaultCdpEndpoint.host}:${defaultCdpEndpoint.port}`;

/**
 * The side strip's single add affordance: a "+" button that opens a small
 * dropdown offering "Browser tab" and "Dev tools". "Browser tab" opens a
 * browser tab directly; "Dev tools" switches the dropdown to the CDP inspect
 * flow (endpoint + target discovery) in the same panel. Both stages render
 * through the shared Popover primitive (click-outside, Escape, overlay
 * lifecycle, viewport clamping); all transport goes through the injected
 * app state, and this component owns only its local menu state (open flag,
 * stage, endpoint draft, discovered targets, error).
 */
export const SideAddMenu: Component<{ app: AppState }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [stage, setStage] = createSignal<"menu" | "cdp">("menu");
  let addButton: HTMLButtonElement | undefined;

  const close = (): void => {
    setOpen(false);
    setStage("menu");
  };

  return (
    <div class="cdp-inspect">
      <button
        ref={addButton}
        type="button"
        class="side-tab-add"
        aria-label="Add tab"
        title="Add tab"
        aria-expanded={open()}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        +
      </button>
      <Popover
        open={open() && stage() === "menu"}
        onClose={close}
        anchor={addButton}
        label="Add tab"
        class="side-add-menu"
        overBrowser
      >
        <div role="menu" aria-label="Add tab">
          <button
            type="button"
            class="menu-item"
            role="menuitem"
            onClick={() => {
              close();
              void props.app.openBrowserSideTab();
            }}
          >
            Browser tab
          </button>
          <button
            type="button"
            class="menu-item"
            role="menuitem"
            onClick={() => setStage("cdp")}
          >
            Dev tools
          </button>
        </div>
      </Popover>
      <Popover
        open={open() && stage() === "cdp"}
        onClose={close}
        anchor={addButton}
        label="Inspect CDP endpoint"
        class="cdp-inspect-popover"
        width={300}
        overBrowser
      >
        <CdpInspectPanel app={props.app} onClose={close} />
      </Popover>
    </div>
  );
};

const CdpInspectPanel: Component<{
  app: AppState;
  onClose: () => void;
}> = (props) => {
  const [endpoint, setEndpoint] = createSignal(defaultEndpointText);
  const [targets, setTargets] = createSignal<readonly CdpTarget[]>([]);
  const [inspecting, setInspecting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const inspect = async (): Promise<void> => {
    setInspecting(true);
    setError(null);
    try {
      setTargets(await props.app.inspectCdp(endpoint()));
    } catch (value) {
      setTargets([]);
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setInspecting(false);
    }
  };

  const openTarget = async (target: CdpTarget): Promise<void> => {
    setError(null);
    try {
      await props.app.openCdpTargetSideTab(endpoint(), target.id);
      props.onClose();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  return (
    <>
      <div class="cdp-inspect-row">
        <input
          class="cdp-inspect-endpoint"
          type="text"
          value={endpoint()}
          placeholder={defaultEndpointText}
          spellcheck={false}
          aria-label="CDP endpoint"
          onInput={(event) => setEndpoint(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void inspect();
            }
          }}
        />
        <button
          type="button"
          class="cdp-inspect-go"
          disabled={inspecting()}
          onClick={() => void inspect()}
        >
          {inspecting() ? "…" : "Inspect"}
        </button>
      </div>
      <Show when={error()}>
        {(message) => <div class="cdp-inspect-error">{message()}</div>}
      </Show>
      <Show
        when={targets().length > 0}
        fallback={
          <div class="cdp-inspect-empty">
            {inspecting()
              ? "Discovering targets…"
              : "No targets discovered yet."}
          </div>
        }
      >
        <div class="cdp-inspect-targets">
          <For each={targets()}>
            {(target) => (
              <button
                type="button"
                class="cdp-inspect-target"
                title={target.url}
                onClick={() => void openTarget(target)}
              >
                <span class="cdp-inspect-target-type">{target.type}</span>
                <span class="cdp-inspect-target-title">
                  {target.title || target.url || target.id}
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
};
