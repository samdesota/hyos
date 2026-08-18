import type { JSX, ParentProps } from "solid-js";
import { splitProps } from "solid-js";
import { cx } from "./utils";

export type IconButtonProps = ParentProps<JSX.ButtonHTMLAttributes<HTMLButtonElement>>;

export function IconButton(props: IconButtonProps) {
  const [local, rest] = splitProps(props, ["class", "children"]);

  return (
    <button class={cx("hy-icon-button", local.class)} {...rest}>
      {local.children}
    </button>
  );
}
