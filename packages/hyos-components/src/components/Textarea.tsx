import type { JSX } from "solid-js";
import { Show, splitProps } from "solid-js";
import { cx } from "./utils";

export type TextareaProps = JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: string;
};

export function Textarea(props: TextareaProps) {
  const [local, rest] = splitProps(props, ["label", "hint", "class"]);

  return (
    <label class="hy-field">
      <Show when={local.label}>
        <span class="hy-field__label">{local.label}</span>
      </Show>
      <textarea class={cx("hy-input hy-textarea", local.class)} {...rest} />
      <Show when={local.hint}>
        <span class="hy-field__hint">{local.hint}</span>
      </Show>
    </label>
  );
}
