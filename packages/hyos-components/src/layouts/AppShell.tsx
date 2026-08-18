import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";
import { Inbox, LayoutDashboard, MoreHorizontal, Settings } from "lucide-solid";
import { IconButton } from "../components";
import { cx } from "../components/utils";

export type AppNavigationItem = {
  label: string;
  icon: Component<{ size?: number }>;
};

export type AppShellProps = {
  title: string;
  eyebrow?: string;
  children: JSX.Element;
  headerAction?: JSX.Element;
  navigationItems?: AppNavigationItem[];
  activeNavigation?: string;
  onNavigationChange?: (label: string) => void;
  showDeviceStatus?: boolean;
  class?: string;
};

const defaultNavigation: AppNavigationItem[] = [
  { label: "Home", icon: LayoutDashboard },
  { label: "Activity", icon: Inbox },
  { label: "Settings", icon: Settings },
];

export function AppShell(props: AppShellProps) {
  const navigationItems = () => props.navigationItems ?? defaultNavigation;
  const activeNavigation = () => props.activeNavigation ?? navigationItems()[0]?.label;

  return (
    <div class={cx("phone-shell", props.class)}>
      <Show when={props.showDeviceStatus !== false}>
        <div class="phone-shell__status" aria-hidden="true">
          <span>9:41</span>
          <span class="phone-shell__island" />
          <span>●●●</span>
        </div>
      </Show>

      <header class="phone-shell__bar">
        <div>
          <span class="micro-label">{props.eyebrow ?? "PERSONAL APP"}</span>
          <strong>{props.title}</strong>
        </div>
        <Show
          when={props.headerAction}
          fallback={
            <IconButton aria-label="More options">
              <MoreHorizontal size={18} />
            </IconButton>
          }
        >
          {props.headerAction}
        </Show>
      </header>

      <div class="phone-shell__content">{props.children}</div>

      <nav class="phone-shell__nav" aria-label={`${props.title} navigation`}>
        <For each={navigationItems()}>
          {(item) => (
            <button
              type="button"
              classList={{ "is-active": activeNavigation() === item.label }}
              aria-current={activeNavigation() === item.label ? "page" : undefined}
              onClick={() => props.onNavigationChange?.(item.label)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </button>
          )}
        </For>
      </nav>
    </div>
  );
}
