import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { cx } from "../components/utils";

export type FeedLayoutProps = {
  hero?: JSX.Element;
  sectionHeader?: JSX.Element;
  children: JSX.Element;
  action?: JSX.Element;
  class?: string;
};

export function FeedLayout(props: FeedLayoutProps) {
  return (
    <div class={cx("hy-layout hy-feed-layout", props.class)}>
      <Show when={props.hero}>
        <header class="hy-feed-layout__hero">{props.hero}</header>
      </Show>
      <Show when={props.sectionHeader}>
        <header class="hy-feed-layout__section-header">{props.sectionHeader}</header>
      </Show>
      <section class="hy-feed-layout__content">{props.children}</section>
      <Show when={props.action}>
        <footer class="hy-feed-layout__action">{props.action}</footer>
      </Show>
    </div>
  );
}
