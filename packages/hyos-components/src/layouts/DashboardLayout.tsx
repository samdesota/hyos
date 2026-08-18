import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { cx } from "../components/utils";

export type DashboardLayoutProps = {
  header?: JSX.Element;
  hero?: JSX.Element;
  metrics?: JSX.Element;
  sectionHeader?: JSX.Element;
  children: JSX.Element;
  class?: string;
};

export function DashboardLayout(props: DashboardLayoutProps) {
  return (
    <div class={cx("hy-layout hy-dashboard-layout", props.class)}>
      <Show when={props.header}>
        <header class="hy-dashboard-layout__header">{props.header}</header>
      </Show>
      <Show when={props.hero}>
        <section class="hy-dashboard-layout__hero">{props.hero}</section>
      </Show>
      <Show when={props.metrics}>
        <section class="hy-dashboard-layout__metrics">{props.metrics}</section>
      </Show>
      <Show when={props.sectionHeader}>
        <header class="hy-dashboard-layout__section-header">{props.sectionHeader}</header>
      </Show>
      <section class="hy-dashboard-layout__content">{props.children}</section>
    </div>
  );
}
