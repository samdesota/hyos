import { ArrowRight, CheckCircle2, CircleDot, ListTodo } from "lucide-solid";
import { For, Show } from "solid-js";

import type { ProjectView, TaskView } from "../data.js";
import { priorityLabels, statusDetails } from "../ui-model.js";

export type AssignedTask = Readonly<{
  project: Pick<ProjectView, "id" | "name" | "color">;
  task: TaskView;
}>;

export function MyTasks(props: {
  tasks: readonly AssignedTask[];
  onOpenProject: (projectId: string) => void;
}) {
  const openCount = () =>
    props.tasks.filter(({ task }) => task.status !== "done").length;
  return (
    <section class="collection-page">
      <header class="collection-header">
        <div class="collection-title">
          <span class="collection-icon">
            <ListTodo size={20} />
          </span>
          <div>
            <span class="eyebrow">Personal workspace</span>
            <h1>My tasks</h1>
          </div>
        </div>
        <p>
          Work assigned to you across the projects this gateway principal can
          read.
        </p>
        <div class="collection-metrics">
          <span>
            <CircleDot size={15} />
            <strong>{openCount()}</strong> open
          </span>
          <span>
            <CheckCircle2 size={15} />
            <strong>{props.tasks.length - openCount()}</strong> complete
          </span>
        </div>
      </header>

      <div class="task-table" role="list">
        <For each={props.tasks}>
          {({ task, project }) => (
            <article class="task-row" role="listitem">
              <span class={`status-mark ${task.status}`} />
              <div class="task-row-copy">
                <h3>{task.title}</h3>
                <Show when={task.description}>
                  <p>{task.description}</p>
                </Show>
              </div>
              <button
                class="project-chip"
                onClick={() => props.onOpenProject(project.id)}
              >
                <span style={{ "background-color": project.color }} />
                {project.name}
              </button>
              <span class={`priority priority-${task.priority}`}>
                {priorityLabels[task.priority]}
              </span>
              <span class="task-status-label">
                {statusDetails[task.status].label}
              </span>
              <button
                class="move-button"
                aria-label={`Open ${project.name}`}
                onClick={() => props.onOpenProject(project.id)}
              >
                <ArrowRight size={14} />
              </button>
            </article>
          )}
        </For>
        <Show when={props.tasks.length === 0}>
          <div class="collection-empty">
            <CheckCircle2 size={22} />
            <h2>Nothing assigned</h2>
            <p>
              Your authorized projects have no tasks assigned to this identity.
            </p>
          </div>
        </Show>
      </div>
    </section>
  );
}
