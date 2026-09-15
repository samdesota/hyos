import { For, Show, createSignal, type Component } from "solid-js";

import type { CdpTarget } from "../../capabilities/browser.js";
import { defaultCdpEndpoint } from "../../capabilities/browser.js";
import type { AppState } from "./app-state.js";

const defaultEndpointText = `${defaultCdpEndpoint.host}:${defaultCdpEndpoint.port}`;

/**
 * The CDP inspect affordance: a small popover off the side-strip's inspect
 * button. Type an endpoint (default localhost:9333), discover its debug
 * targets, and open one as a DevTools pane in the side strip. All transport
 * goes through the injected app state; this component owns only its local
 * popover state (open flag, endpoint draft, discovered targets, error).
 */
export const CdpInspectPopover: Component<{ app: AppState }> = (props) => {
  const [open, setOpen] = createSignal(false);
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
      setOpen(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  return (
    <div class="cdp-inspect">
      <button
        type="button"
        class="side-tab-add"
        aria-label="Inspect CDP endpoint"
        title="Inspect CDP endpoint (DevTools)"
        aria-expanded={open()}
        onClick={() => setOpen((current) => !current)}
      >
        ⚒
      </button>
      <Show when={open()}>
        <div
          class="cdp-inspect-popover"
          role="dialog"
          aria-label="Inspect CDP endpoint"
        >
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
        </div>
      </Show>
    </div>
  );
};
