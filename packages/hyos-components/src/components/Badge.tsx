import type { ParentProps } from "solid-js";
import { cx } from "./utils";

export type BadgeProps = ParentProps<{
  tone?: "neutral" | "accent" | "success" | "warning";
  class?: string;
}>;

export function Badge(props: BadgeProps) {
  return (
    <span class={cx("hy-badge", `hy-badge--${props.tone ?? "neutral"}`, props.class)}>
      {props.children}
    </span>
  );
}
