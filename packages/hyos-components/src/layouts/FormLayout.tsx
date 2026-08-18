import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { cx } from "../components/utils";

export type FormLayoutProps = {
  intro?: JSX.Element;
  children: JSX.Element;
  action?: JSX.Element;
  class?: string;
};

export function FormLayout(props: FormLayoutProps) {
  return (
    <div class={cx("hy-layout hy-form-layout", props.class)}>
      <Show when={props.intro}>
        <header class="hy-form-layout__intro">{props.intro}</header>
      </Show>
      <section class="hy-form-layout__fields">{props.children}</section>
      <Show when={props.action}>
        <footer class="hy-form-layout__action">{props.action}</footer>
      </Show>
    </div>
  );
}
