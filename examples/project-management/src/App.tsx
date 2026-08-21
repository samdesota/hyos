import {
  Activity,
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  CircleDot,
  Command,
  Database,
  Gauge,
  LayoutDashboard,
  ListTodo,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Users,
  X,
  Zap,
} from "lucide-solid";
import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import type { Database as HyDatabase } from "@hyos/hydb";

import {
  assignTask,
  createDemoDatabase,
  createProject,
  createTask,
  deleteTask,
  moveTask,
  projectBoardQuery,
  rebalanceSprint,
  taskStatuses,
  teamQuery,
  type ProjectBoard,
  type ProjectView,
  type TaskStatus,
  type TaskView,
  type Team,
} from "./data.js";

type ActivityEntry = Readonly<{
  id: number;
  title: string;
  detail: string;
  time: string;
  kind: "query" | "command";
}>;

const statusDetails: Record<
  TaskStatus,
  Readonly<{ label: string; eyebrow: string; next?: TaskStatus }>
> = {
  backlog: { label: "Backlog", eyebrow: "Queue", next: "in_progress" },
  in_progress: { label: "In progress", eyebrow: "Active", next: "done" },
  done: { label: "Done", eyebrow: "Complete" },
};

const priorityLabels = ["", "Low", "Normal", "High", "Urgent"];

export function App() {
  const [database, setDatabase] = createSignal<HyDatabase>();
  const [projectList, setProjectList] = createSignal<ProjectBoard>([]);
  const [team, setTeam] = createSignal<Team>([]);
  const [selectedProjectId, setSelectedProjectId] =
    createSignal("project-hydb");
  const [search, setSearch] = createSignal("");
  const [showTaskDialog, setShowTaskDialog] = createSignal(false);
  const [showProjectDialog, setShowProjectDialog] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [runningCommand, setRunningCommand] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [materializationCount, setMaterializationCount] = createSignal(0);
  const [activities, setActivities] = createSignal<ActivityEntry[]>([]);
  let activityId = 0;
  let unsubscribeProjects: (() => void) | undefined;
  let unsubscribeTeam: (() => void) | undefined;
  let disposed = false;

  const activeProject = createMemo<ProjectView | undefined>(() => {
    const projects = projectList();
    return (
      projects.find((project) => project.id === selectedProjectId()) ??
      projects[0]
    );
  });

  const visibleTasks = createMemo(() => {
    const needle = search().trim().toLowerCase();
    const tasks = activeProject()?.tasks ?? [];
    if (needle.length === 0) return tasks;
    return tasks.filter(
      (task) =>
        task.title.toLowerCase().includes(needle) ||
        task.description.toLowerCase().includes(needle) ||
        task.assignee?.name.toLowerCase().includes(needle),
    );
  });

  const totalTasks = createMemo(() =>
    projectList().reduce((total, project) => total + project.tasks.length, 0),
  );
  const completedTasks = createMemo(() =>
    projectList().reduce((total, project) => total + project.completedCount, 0),
  );

  function appendActivity(entry: Omit<ActivityEntry, "id" | "time">) {
    const now = new Date();
    setActivities((current) =>
      [
        {
          ...entry,
          id: ++activityId,
          time: now.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        },
        ...current,
      ].slice(0, 8),
    );
  }

  onMount(() => {
    void (async () => {
      const db = await createDemoDatabase();
      if (disposed) {
        await db.close();
        return;
      }
      setDatabase(db);
      unsubscribeProjects = db.subscribe(projectBoardQuery, (projects) => {
        setProjectList(projects);
        setMaterializationCount((count) => count + 1);
        appendActivity({
          kind: "query",
          title: "Board materialized",
          detail: `${projects.length} projects · ${projects.reduce(
            (count, project) => count + project.tasks.length,
            0,
          )} nested tasks`,
        });
      });
      unsubscribeTeam = db.subscribe(teamQuery, setTeam);
      setLoading(false);
    })().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    });
  });

  onCleanup(() => {
    disposed = true;
    unsubscribeProjects?.();
    unsubscribeTeam?.();
    const db = database();
    if (db !== undefined) void db.close();
  });

  async function runCommand(
    label: string,
    action: (db: HyDatabase) => Promise<unknown>,
  ): Promise<boolean> {
    const db = database();
    if (db === undefined || runningCommand() !== undefined) return false;
    setError(undefined);
    setRunningCommand(label);
    const startedAt = performance.now();
    try {
      await action(db);
      appendActivity({
        kind: "command",
        title: label,
        detail: `Committed and settled in ${Math.max(
          1,
          Math.round(performance.now() - startedAt),
        )}ms`,
      });
      return true;
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setRunningCommand(undefined);
    }
  }

  async function changeTaskStatus(taskId: string, status: TaskStatus) {
    await runCommand(`Move task to ${statusDetails[status].label}`, (db) =>
      db.execute(moveTask, { taskId, status }),
    );
  }

  async function changeAssignee(taskId: string, assigneeId: string | null) {
    await runCommand("Update task owner", (db) =>
      db.execute(assignTask, { taskId, assigneeId }),
    );
  }

  async function removeTask(taskId: string) {
    await runCommand("Delete task", (db) => db.execute(deleteTask, { taskId }));
  }

  async function runRebalance() {
    const project = activeProject();
    if (project === undefined || project.tasks.length === 0) return;
    const moves = project.tasks.slice(0, 4).map((task, index) => ({
      taskId: task.id,
      status:
        taskStatuses[
          (taskStatuses.indexOf(task.status) + 1 + index) % taskStatuses.length
        ]!,
    }));
    await runCommand(`Atomic sprint rebalance (${moves.length} writes)`, (db) =>
      db.execute(rebalanceSprint, { moves }),
    );
  }

  async function submitTask(event: SubmitEvent) {
    event.preventDefault();
    const project = activeProject();
    if (project === undefined) return;
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const success = await runCommand("Create task", (db) =>
      db.execute(createTask, {
        projectId: project.id,
        title: String(values.get("title") ?? ""),
        description: String(values.get("description") ?? ""),
        status: String(values.get("status") ?? "backlog") as TaskStatus,
        priority: Number(values.get("priority") ?? 2),
        assigneeId: String(values.get("assigneeId") ?? "") || null,
      }),
    );
    if (success) {
      form.reset();
      setShowTaskDialog(false);
    }
  }

  async function submitProject(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    let projectId: string | undefined;
    const success = await runCommand("Create project", async (db) => {
      const project = await db.execute(createProject, {
        name: String(values.get("name") ?? ""),
        description: String(values.get("description") ?? ""),
      });
      projectId = project.id;
    });
    if (success) {
      if (projectId !== undefined) setSelectedProjectId(projectId);
      form.reset();
      setShowProjectDialog(false);
    }
  }

  return (
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">
            <Sparkles size={17} stroke-width={2.2} />
          </div>
          <div>
            <strong>Northstar</strong>
            <span>HyDB prototype</span>
          </div>
        </div>

        <nav class="primary-nav" aria-label="Workspace navigation">
          <button class="nav-item active">
            <LayoutDashboard size={17} /> Overview
          </button>
          <button class="nav-item">
            <ListTodo size={17} /> My tasks
            <span class="nav-count">{totalTasks()}</span>
          </button>
          <button class="nav-item">
            <Users size={17} /> Team
          </button>
        </nav>

        <div class="sidebar-section">
          <div class="section-heading">
            <span>Projects</span>
            <button
              class="icon-button small"
              aria-label="Create project"
              onClick={() => setShowProjectDialog(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          <div class="project-nav">
            <For each={projectList()}>
              {(project) => (
                <button
                  class="project-nav-item"
                  classList={{ selected: activeProject()?.id === project.id }}
                  onClick={() => setSelectedProjectId(project.id)}
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
            <span class="pulse-dot" /> Live engine
            <span>online</span>
          </div>
          <p>In-memory DDF graph</p>
          <div class="engine-stat">
            <Zap size={14} /> {materializationCount()} materializations
          </div>
        </div>
        <div class="profile-row">
          <span class="avatar avatar-sam">SA</span>
          <div>
            <strong>Sam</strong>
            <span>Workspace owner</span>
          </div>
          <MoreHorizontal size={17} />
        </div>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <div class="search-box">
            <Search size={17} />
            <input
              aria-label="Search tasks"
              placeholder="Search this project…"
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
            <kbd>⌘ K</kbd>
          </div>
          <div class="topbar-actions">
            <div class="team-stack">
              <For each={team().slice(0, 4)}>
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

        <Show
          when={!loading() && activeProject()}
          fallback={<LoadingState error={error()} />}
        >
          {(project) => (
            <div class="content-grid">
              <section class="board-area">
                <div class="project-header">
                  <div class="project-title-row">
                    <span
                      class="project-icon"
                      style={{ "background-color": project().color }}
                    >
                      {project().name.slice(0, 1)}
                    </span>
                    <div>
                      <div class="eyebrow">Projects / {project().name}</div>
                      <h1>{project().name}</h1>
                    </div>
                    <button class="icon-button">
                      <ChevronDown size={17} />
                    </button>
                  </div>
                  <p>{project().description}</p>
                  <div class="project-toolbar">
                    <div class="metric">
                      <Gauge size={16} />
                      <strong>{project().tasks.length}</strong> total tasks
                    </div>
                    <div class="metric">
                      <Check size={16} />
                      <strong>{project().completedCount}</strong> complete
                    </div>
                    <div class="progress-track" title="Project completion">
                      <span
                        style={{
                          width: `${
                            project().tasks.length === 0
                              ? 0
                              : Math.round(
                                  (project().completedCount /
                                    project().tasks.length) *
                                    100,
                                )
                          }%`,
                        }}
                      />
                    </div>
                    <div class="toolbar-spacer" />
                    <button class="secondary-button" onClick={runRebalance}>
                      <Activity size={16} /> Atomic rebalance
                    </button>
                    <button
                      class="primary-button"
                      onClick={() => setShowTaskDialog(true)}
                    >
                      <Plus size={16} /> Add task
                    </button>
                  </div>
                </div>

                <Show when={error()}>
                  {(message) => (
                    <div class="error-banner">
                      <CircleDot size={16} /> {message()}
                      <button onClick={() => setError(undefined)}>
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
                        tasks={visibleTasks().filter(
                          (task) => task.status === status,
                        )}
                        team={team()}
                        onMove={changeTaskStatus}
                        onAssign={changeAssignee}
                        onDelete={removeTask}
                        onCreate={() => setShowTaskDialog(true)}
                      />
                    )}
                  </For>
                </div>
              </section>

              <aside class="inspector">
                <div class="inspector-heading">
                  <div>
                    <span class="pulse-dot" />
                    <strong>Live inspector</strong>
                  </div>
                  <span>DDF</span>
                </div>
                <p class="inspector-intro">
                  Every command below became weighted changes and settled into
                  this nested board.
                </p>
                <div class="inspector-stats">
                  <div>
                    <Database size={16} />
                    <span>
                      <strong>{projectList().length}</strong> projects
                    </span>
                  </div>
                  <div>
                    <ListTodo size={16} />
                    <span>
                      <strong>{totalTasks()}</strong> nested tasks
                    </span>
                  </div>
                  <div>
                    <Check size={16} />
                    <span>
                      <strong>{completedTasks()}</strong> completed
                    </span>
                  </div>
                </div>
                <div class="activity-heading">
                  <span>Recent propagation</span>
                  <small>{runningCommand() ?? "settled"}</small>
                </div>
                <div class="activity-list">
                  <For each={activities()}>
                    {(entry) => (
                      <div class="activity-item">
                        <span classList={{ query: entry.kind === "query" }}>
                          {entry.kind === "query" ? (
                            <Zap size={13} />
                          ) : (
                            <Command size={13} />
                          )}
                        </span>
                        <div>
                          <strong>{entry.title}</strong>
                          <p>{entry.detail}</p>
                        </div>
                        <time>{entry.time}</time>
                      </div>
                    )}
                  </For>
                </div>
                <details class="state-panel">
                  <summary>
                    Current nested result <ChevronDown size={14} />
                  </summary>
                  <pre>{JSON.stringify(project(), null, 2)}</pre>
                </details>
                <div class="prototype-note">
                  <Sparkles size={15} />
                  <span>
                    <strong>Front-end only</strong> — reload to reset the
                    in-memory database.
                  </span>
                </div>
              </aside>
            </div>
          )}
        </Show>
      </main>

      <Show when={showTaskDialog() && activeProject()}>
        {(project) => (
          <Dialog
            title="Create a task"
            subtitle={`Add work to ${project().name}`}
            onClose={() => setShowTaskDialog(false)}
          >
            <form class="dialog-form" onSubmit={submitTask}>
              <label>
                Task title
                <input
                  name="title"
                  autofocus
                  placeholder="What needs to happen?"
                  required
                  minlength="2"
                />
              </label>
              <label>
                Description
                <textarea
                  name="description"
                  rows="3"
                  placeholder="Add a little context…"
                />
              </label>
              <div class="form-row">
                <label>
                  Status
                  <select name="status">
                    <option value="backlog">Backlog</option>
                    <option value="in_progress">In progress</option>
                    <option value="done">Done</option>
                  </select>
                </label>
                <label>
                  Priority
                  <select name="priority">
                    <option value="1">Low</option>
                    <option value="2" selected>
                      Normal
                    </option>
                    <option value="3">High</option>
                    <option value="4">Urgent</option>
                  </select>
                </label>
              </div>
              <label>
                Assignee
                <select name="assigneeId">
                  <option value="">Unassigned</option>
                  <For each={team()}>
                    {(member) => (
                      <option value={member.id}>{member.name}</option>
                    )}
                  </For>
                </select>
              </label>
              <div class="dialog-actions">
                <button
                  type="button"
                  class="secondary-button"
                  onClick={() => setShowTaskDialog(false)}
                >
                  Cancel
                </button>
                <button
                  class="primary-button"
                  disabled={runningCommand() !== undefined}
                >
                  Create task
                </button>
              </div>
            </form>
          </Dialog>
        )}
      </Show>

      <Show when={showProjectDialog()}>
        <Dialog
          title="Create a project"
          subtitle="Start a fresh stream of work"
          onClose={() => setShowProjectDialog(false)}
        >
          <form class="dialog-form" onSubmit={submitProject}>
            <label>
              Project name
              <input
                name="name"
                autofocus
                placeholder="e.g. Mobile beta"
                required
                minlength="2"
              />
            </label>
            <label>
              Description
              <textarea
                name="description"
                rows="3"
                placeholder="What is this project here to accomplish?"
              />
            </label>
            <div class="dialog-actions">
              <button
                type="button"
                class="secondary-button"
                onClick={() => setShowProjectDialog(false)}
              >
                Cancel
              </button>
              <button
                class="primary-button"
                disabled={runningCommand() !== undefined}
              >
                Create project
              </button>
            </div>
          </form>
        </Dialog>
      </Show>
    </div>
  );
}

function TaskColumn(props: {
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

function Dialog(props: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: JSX.Element;
}) {
  return (
    <div
      class="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) =>
        event.target === event.currentTarget && props.onClose()
      }
    >
      <section
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <header>
          <div>
            <h2>{props.title}</h2>
            <p>{props.subtitle}</p>
          </div>
          <button class="icon-button" onClick={props.onClose}>
            <X size={18} />
          </button>
        </header>
        {props.children}
      </section>
    </div>
  );
}

function LoadingState(props: { error?: string }) {
  return (
    <div class="loading-state">
      <div class="loading-mark">
        <Database size={24} />
      </div>
      <h2>{props.error ? "Could not start the demo" : "Starting HyDB"}</h2>
      <p>
        {props.error ??
          "Seeding the in-memory database and compiling live queries…"}
      </p>
    </div>
  );
}
