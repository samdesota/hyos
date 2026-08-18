import type { ParentProps } from "solid-js";
import { cx } from "./utils";

export type CardProps = ParentProps<{ class?: string; interactive?: boolean }>;

export function Card(props: CardProps) {
  return (
    <div class={cx("hy-card", props.interactive && "hy-card--interactive", props.class)}>
      {props.children}
    </div>
  );
}
