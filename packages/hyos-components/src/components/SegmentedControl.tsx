import { For } from "solid-js";

export type SegmentedControlProps<T extends string> = {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label: string;
};

export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  return (
    <div class="hy-segments" role="group" aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            class="hy-segments__item"
            aria-pressed={props.value === option}
            onClick={() => props.onChange(option)}
          >
            {option}
          </button>
        )}
      </For>
    </div>
  );
}
