import { Check } from "lucide-solid";
import { Show } from "solid-js";

export type CheckboxProps = {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label: string;
};

export function Checkbox(props: CheckboxProps) {
  return (
    <label class="hy-checkbox-row">
      <button
        type="button"
        role="checkbox"
        aria-checked={props.checked}
        class="hy-checkbox"
        onClick={() => props.onChange?.(!props.checked)}
      >
        <Show when={props.checked}>
          <Check size={14} stroke-width={3} />
        </Show>
      </button>
      <span>{props.label}</span>
    </label>
  );
}
