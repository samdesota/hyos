import {
  Activity,
  Check,
  ChevronDown,
  CircleDot,
  Gauge,
  Plus,
  X,
} from "lucide-solid";
import { For, Show } from "solid-js";

import {
  taskStatuses,
  type ProjectView,
  type TaskStatus,
  type TaskView,
  type Team,
} from "../data.js";
import { TaskColumn } from "./TaskColumn.js";

export function ProjectBoard(props: {
  project: ProjectView;
  visibleTasks: readonly TaskView[];
  team: Team;
  error?: string;
  onDismissError: () => void;
  onRebalance: () => void;
  onCreateTask: () => void;
  onMove: (taskId: string, status: TaskStatus) => void;
  onAssign: (taskId: string, assigneeId: string | null) => void;
  onDelete: (taskId: string) => void;
}) {
  return (
    <section class="board-area">
      <div class="project-header">
        <div class="project-title-row">
          <span
            class="project-icon"
            style={{ "background-color": props.project.color }}
          >
            {props.project.name.slice(0, 1)}
          </span>
          <div>
            <div class="eyebrow">Projects / {props.project.name}</div>
            <h1>{props.project.name}</h1>
          </div>
          <button class="icon-button">
            <ChevronDown size={17} />
          </button>
        </div>
        <p>{props.project.description}</p>
        <div class="project-toolbar">
          <div class="metric">
            <Gauge size={16} />
            <strong>{props.project.tasks.length}</strong> total tasks
          </div>
          <div class="metric">
            <Check size={16} />
            <strong>{props.project.completedCount}</strong> complete
          </div>
          <div class="progress-track" title="Project completion">
            <span
              style={{
                width: `${props.project.tasks.length === 0 ? 0 : Math.round((props.project.completedCount / props.project.tasks.length) * 100)}%`,
              }}
            />
          </div>
          <div class="toolbar-spacer" />
          <button class="secondary-button" onClick={props.onRebalance}>
            <Activity size={16} /> Atomic rebalance
          </button>
          <button class="primary-button" onClick={props.onCreateTask}>
            <Plus size={16} /> Add task
          </button>
        </div>
      </div>

      <Show when={props.error}>
        {(message) => (
          <div class="error-banner">
            <CircleDot size={16} /> {message()}
            <button onClick={props.onDismissError}>
              <X size={15} />
            </button>
          </div>
        )}
      </Show>

      <div class="kanban-board">
        <For each={taskStatuses}>
          {(status) => (
            <TaskColumn
              status={status}
              tasks={props.visibleTasks.filter(
                (task) => task.status === status,
              )}
              team={props.team}
              onMove={props.onMove}
              onAssign={props.onAssign}
              onDelete={props.onDelete}
              onCreate={props.onCreateTask}
            />
          )}
        </For>
      </div>
    </section>
  );
}
