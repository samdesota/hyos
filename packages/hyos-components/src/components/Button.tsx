import type { JSX, ParentProps } from "solid-js";
import { splitProps } from "solid-js";
import { cx } from "./utils";

export type ButtonProps = ParentProps<
  JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "quiet" | "danger";
    size?: "sm" | "md" | "lg";
  }
>;

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "size", "class", "children"]);

  return (
    <button
      class={cx(
        "hy-button",
        `hy-button--${local.variant ?? "primary"}`,
        `hy-button--${local.size ?? "md"}`,
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </button>
  );
}
