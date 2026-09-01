import type { Component } from "solid-js";
import type { BrowserTabState } from "../../capabilities/browser.js";

type BrowserToolbarProps = Readonly<{
  tab?: BrowserTabState;
  address: string;
  setAddress(value: string): void;
  navigate(): void;
  back(): void;
  forward(): void;
  reload(): void;
}>;

export const BrowserToolbar: Component<BrowserToolbarProps> = (props) => (
  <form
    class="toolbar"
    onSubmit={(event) => {
      event.preventDefault();
      props.navigate();
    }}
  >
    <button
      type="button"
      aria-label="Back"
      disabled={!props.tab?.canGoBack}
      onClick={props.back}
    >
      ←
    </button>
    <button
      type="button"
      aria-label="Forward"
      disabled={!props.tab?.canGoForward}
      onClick={props.forward}
    >
      →
    </button>
    <button type="button" aria-label="Reload" onClick={props.reload}>
      {props.tab?.loading ? "×" : "↻"}
    </button>
    <input
      id="address"
      aria-label="Address"
      value={props.address}
      onInput={(event) => props.setAddress(event.currentTarget.value)}
    />
    <button class="go" type="submit">
      Go
    </button>
  </form>
);
