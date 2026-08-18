import type { JSX } from "solid-js";
import { Show, splitProps } from "solid-js";
import { cx } from "./utils";

export type InputProps = JSX.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Input(props: InputProps) {
  const [local, rest] = splitProps(props, ["label", "hint", "error", "class"]);

  return (
    <label class="hy-field">
      <Show when={local.label}>
        <span class="hy-field__label">{local.label}</span>
      </Show>
      <input
        class={cx("hy-input", local.error && "hy-input--error", local.class)}
        aria-invalid={Boolean(local.error)}
        {...rest}
      />
      <Show when={local.error} fallback={<span class="hy-field__hint">{local.hint}</span>}>
        <span class="hy-field__error">{local.error}</span>
      </Show>
    </label>
  );
}
