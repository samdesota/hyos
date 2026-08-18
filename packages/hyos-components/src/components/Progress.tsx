import { Show } from "solid-js";

export type ProgressProps = { value: number; label?: string };

export function Progress(props: ProgressProps) {
  return (
    <div class="hy-progress-wrap">
      <Show when={props.label}>
        <div class="hy-progress-label">
          <span>{props.label}</span>
          <span>{props.value}%</span>
        </div>
      </Show>
      <div class="hy-progress" role="progressbar" aria-valuenow={props.value}>
        <span class="hy-progress__fill" style={{ width: `${props.value}%` }} />
      </div>
    </div>
  );
}
