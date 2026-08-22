import { ArrowRight, CircleDot, Plus, Trash2 } from "lucide-solid";
import { For, Show } from "solid-js";

import type { TaskStatus, TaskView, Team } from "../data.js";
import { priorityLabels, statusDetails } from "../ui-model.js";

export function TaskColumn(props: {
  status: TaskStatus;
  tasks: readonly TaskView[];
  team: Team;
  onMove: (taskId: string, status: TaskStatus) => void;
  onAssign: (taskId: string, assigneeId: string | null) => void;
  onDelete: (taskId: string) => void;
  onCreate: () => void;
}) {
  const details = () => statusDetails[props.status];
  return (
    <section
      class="task-column"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const taskId = event.dataTransfer?.getData("application/x-hydb-task");
        if (taskId) props.onMove(taskId, props.status);
      }}
    >
      <header class="column-header">
        <div>
          <span class={`status-mark ${props.status}`} />{" "}
          <strong>{details().label}</strong>
          <span class="task-count">{props.tasks.length}</span>
        </div>
        <span>{details().eyebrow}</span>
      </header>
      <div class="task-list">
        <For each={props.tasks}>
          {(task) => (
            <article
              class="task-card"
              draggable={true}
              onDragStart={(event) =>
                event.dataTransfer?.setData("application/x-hydb-task", task.id)
              }
            >
              <div class="task-card-top">
                <span class={`priority priority-${task.priority}`}>
                  <For each={[1, 2, 3, 4].slice(0, task.priority)}>
                    {() => <i />}
                  </For>
                  {priorityLabels[task.priority]}
                </span>
                <button
                  class="card-icon"
                  aria-label="Delete task"
                  onClick={() => props.onDelete(task.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <h3>{task.title}</h3>
              <Show when={task.description}>
                <p>{task.description}</p>
              </Show>
              <div class="task-card-footer">
                <label class="assignee-select" title="Change assignee">
                  <Show
                    when={task.assignee}
                    fallback={<span class="avatar unassigned">+</span>}
                  >
                    {(assignee) => (
                      <span
                        class="avatar"
                        style={{ "background-color": assignee().color }}
                      >
                        {assignee().initials}
                      </span>
                    )}
                  </Show>
                  <select
                    aria-label={`Assignee for ${task.title}`}
                    value={task.assignee?.id ?? ""}
                    onChange={(event) =>
                      props.onAssign(task.id, event.currentTarget.value || null)
                    }
                  >
                    <option value="">Unassigned</option>
                    <For each={props.team}>
                      {(member) => (
                        <option value={member.id}>{member.name}</option>
                      )}
                    </For>
                  </select>
                </label>
                <Show when={details().next}>
                  {(next) => (
                    <button
                      class="move-button"
                      title={`Move to ${statusDetails[next()].label}`}
                      onClick={() => props.onMove(task.id, next())}
                    >
                      <ArrowRight size={14} />
                    </button>
                  )}
                </Show>
              </div>
            </article>
          )}
        </For>
        <Show when={props.tasks.length === 0}>
          <div class="empty-column">
            <CircleDot size={18} />
            <span>Drop a task here</span>
          </div>
        </Show>
      </div>
      <button class="add-task-row" onClick={props.onCreate}>
        <Plus size={15} /> Add task
      </button>
    </section>
  );
}
