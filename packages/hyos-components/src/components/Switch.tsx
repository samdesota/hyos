import { Show } from "solid-js";

export type SwitchProps = {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label: string;
  description?: string;
};

export function Switch(props: SwitchProps) {
  return (
    <label class="hy-switch-row">
      <span>
        <span class="hy-switch-row__label">{props.label}</span>
        <Show when={props.description}>
          <span class="hy-switch-row__description">{props.description}</span>
        </Show>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        class="hy-switch"
        onClick={() => props.onChange?.(!props.checked)}
      >
        <span class="hy-switch__thumb" />
      </button>
    </label>
  );
}
