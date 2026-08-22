import { useLocation, useNavigate } from "@solidjs/router";
import {
  LayoutDashboard,
  ListTodo,
  LogOut,
  Plus,
  Sparkles,
  Users,
  Zap,
} from "lucide-solid";
import { For } from "solid-js";

import type { ProjectBoard } from "../data.js";
import type { DemoPerson } from "../demo-people.js";

export function Sidebar(props: {
  projects: ProjectBoard;
  activeProjectId?: string;
  currentUser: DemoPerson;
  myTaskCount: number;
  materializations: number;
  onCreateProject: () => void;
  onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const overviewPath = () =>
    `/projects/${props.activeProjectId ?? props.projects[0]?.id ?? ""}`;
  return (
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">
          <Sparkles size={17} stroke-width={2.2} />
        </div>
        <div>
          <strong>Northstar</strong>
          <span>HyApp workspace</span>
        </div>
      </div>

      <nav class="primary-nav" aria-label="Workspace navigation">
        <button
          class="nav-item"
          classList={{ active: location.pathname.startsWith("/projects") }}
          onClick={() => navigate(overviewPath())}
        >
          <LayoutDashboard size={17} /> Overview
        </button>
        <button
          class="nav-item"
          classList={{ active: location.pathname === "/tasks" }}
          onClick={() => navigate("/tasks")}
        >
          <ListTodo size={17} /> My tasks{" "}
          <span class="nav-count">{props.myTaskCount}</span>
        </button>
        <button
          class="nav-item"
          classList={{ active: location.pathname === "/team" }}
          onClick={() => navigate("/team")}
        >
          <Users size={17} /> Team
        </button>
      </nav>

      <div class="sidebar-section">
        <div class="section-heading">
          <span>Projects</span>
          <button
            class="icon-button small"
            aria-label="Create project"
            onClick={props.onCreateProject}
          >
            <Plus size={15} />
          </button>
        </div>
        <div class="project-nav">
          <For each={props.projects}>
            {(project) => (
              <button
                class="project-nav-item"
                classList={{ selected: props.activeProjectId === project.id }}
                onClick={() => navigate(`/projects/${project.id}`)}
              >
                <span
                  class="project-dot"
                  style={{ "background-color": project.color }}
                />
                <span>{project.name}</span>
                <small>{project.openCount}</small>
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="sidebar-spacer" />
      <div class="engine-card">
        <div class="engine-card-title">
          <span class="pulse-dot" /> Live engine <span>online</span>
        </div>
        <p>Persistent policy gateway</p>
        <div class="engine-stat">
          <Zap size={14} /> {props.materializations} materializations
        </div>
      </div>
      <div class="profile-row">
        <span
          class="avatar"
          style={{ "background-color": props.currentUser.color }}
        >
          {props.currentUser.initials}
        </span>
        <div>
          <strong data-testid="current-user">{props.currentUser.name}</strong>
          <button
            class="sign-out-button"
            aria-label="Sign out"
            onClick={props.onSignOut}
          >
            <LogOut size={11} /> Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
