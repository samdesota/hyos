import { Bell, Search } from "lucide-solid";
import { For, type Accessor } from "solid-js";

import type { Team } from "../data.js";

export function Topbar(props: {
  search: Accessor<string>;
  setSearch: (value: string) => void;
  team: Team;
  placeholder?: string;
}) {
  return (
    <header class="topbar">
      <div class="search-box">
        <Search size={17} />
        <input
          aria-label="Search tasks"
          placeholder={props.placeholder ?? "Search this project…"}
          value={props.search()}
          onInput={(event) => props.setSearch(event.currentTarget.value)}
        />
        <kbd>⌘ K</kbd>
      </div>
      <div class="topbar-actions">
        <div class="team-stack">
          <For each={props.team.slice(0, 4)}>
            {(member) => (
              <span
                class="avatar"
                title={member.name}
                style={{ "background-color": member.color }}
              >
                {member.initials}
              </span>
            )}
          </For>
        </div>
        <button class="icon-button" aria-label="Notifications">
          <Bell size={18} />
        </button>
        <button class="live-pill">
          <span class="pulse-dot" /> Live
        </button>
      </div>
    </header>
  );
}
