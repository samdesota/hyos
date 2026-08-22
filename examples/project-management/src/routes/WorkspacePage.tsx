import { Navigate, useLocation, useNavigate, useParams } from "@solidjs/router";
import { createGatewayCommand, createGatewayQuery } from "@hyos/hyapp/solid";
import { Database } from "lucide-solid";
import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";

import { useAuth } from "../auth.js";
import { Dialog } from "../components/Dialog.js";
import { Inspector } from "../components/Inspector.js";
import { MyTasks, type AssignedTask } from "../components/MyTasks.js";
import { ProjectBoard } from "../components/ProjectBoard.js";
import { Sidebar } from "../components/Sidebar.js";
import {
  TeamDirectory,
  type TeamMemberSummary,
} from "../components/TeamDirectory.js";
import { Topbar } from "../components/Topbar.js";
import {
  projectBoardQuery,
  taskStatuses,
  teamQuery,
  type ProjectView,
  type TaskStatus,
} from "../data.js";
import { findDemoPerson } from "../demo-people.js";
import { useGateway } from "../gateway.js";
import {
  projectColors,
  statusDetails,
  type ActivityEntry,
} from "../ui-model.js";

export function WorkspacePage() {
  const auth = useAuth();
  const gateway = useGateway();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ projectId?: string }>();
  const board = createGatewayQuery(gateway, projectBoardQuery);
  const team = createGatewayQuery(gateway, teamQuery);
  const createProject = createGatewayCommand(gateway, "createProject");
  const createTask = createGatewayCommand(gateway, "createTask");
  const moveTask = createGatewayCommand(gateway, "moveTask");
  const assignTask = createGatewayCommand(gateway, "assignTask");
  const deleteTask = createGatewayCommand(gateway, "deleteTask");
  const rebalanceSprint = createGatewayCommand(gateway, "rebalanceSprint");

  const [search, setSearch] = createSignal("");
  const [showTaskDialog, setShowTaskDialog] = createSignal(false);
  const [showProjectDialog, setShowProjectDialog] = createSignal(false);
  const [runningCommand, setRunningCommand] = createSignal<string>();
  const [localError, setLocalError] = createSignal<string>();
  const [materializationCount, setMaterializationCount] = createSignal(0);
  const [activities, setActivities] = createSignal<ActivityEntry[]>([]);
  const [pendingProjectRoute, setPendingProjectRoute] = createSignal<string>();
  let activityId = 0;
  let searchedPath = location.pathname;

  const projects = () => board.data() ?? [];
  const members = () => team.data() ?? [];
  const activeProject = createMemo<ProjectView | undefined>(() =>
    projects().find((project) => project.id === params.projectId),
  );
  const currentUser = createMemo(() => findDemoPerson(auth.userId()));
  const visibleTasks = createMemo(() => {
    const needle = search().trim().toLowerCase();
    const tasks = activeProject()?.tasks ?? [];
    if (needle.length === 0) return tasks;
    return tasks.filter((task) =>
      [task.title, task.description, task.assignee?.name]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    );
  });
  const totalTasks = createMemo(() =>
    projects().reduce((sum, project) => sum + project.tasks.length, 0),
  );
  const completedTasks = createMemo(() =>
    projects().reduce((sum, project) => sum + project.completedCount, 0),
  );
  const assignedTasks = createMemo<readonly AssignedTask[]>(() => {
    const userId = auth.userId();
    return projects().flatMap((project) =>
      project.tasks
        .filter((task) => task.assignee?.id === userId)
        .map((task) => ({
          task,
          project: {
            id: project.id,
            name: project.name,
            color: project.color,
          },
        })),
    );
  });
  const visibleAssignedTasks = createMemo(() => {
    const needle = search().trim().toLowerCase();
    if (needle.length === 0) return assignedTasks();
    return assignedTasks().filter(({ task, project }) =>
      [task.title, task.description, project.name].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  });
  const teamMembers = createMemo<readonly TeamMemberSummary[]>(() => {
    const needle = search().trim().toLowerCase();
    return members()
      .filter((member) => member.name.toLowerCase().includes(needle))
      .map((member) => {
        const memberTasks = projects().flatMap((project) =>
          project.tasks
            .filter((task) => task.assignee?.id === member.id)
            .map((task) => ({ task, projectId: project.id })),
        );
        return {
          member,
          assigned: memberTasks.length,
          completed: memberTasks.filter(({ task }) => task.status === "done")
            .length,
          projectCount: new Set(memberTasks.map(({ projectId }) => projectId))
            .size,
          current: member.id === auth.userId(),
        };
      });
  });
  const queryError = createMemo(() =>
    errorMessage(board.error() ?? team.error()),
  );
  const loading = createMemo(() => board.loading() || team.loading());

  createEffect(() => {
    const pathname = location.pathname;
    if (pathname !== searchedPath) {
      searchedPath = pathname;
      setSearch("");
    }
  });

  createEffect(() => {
    const result = board.data();
    if (result === undefined) return;
    setMaterializationCount((count) => count + 1);
    appendActivity({
      kind: "query",
      title: "Board materialized",
      detail: `${result.length} projects · ${result.reduce((count, project) => count + project.tasks.length, 0)} nested tasks`,
    });
  });

  const redirectProjectId = createMemo(() => {
    if (!location.pathname.startsWith("/projects")) return undefined;
    const result = projects();
    if (
      board.loading() ||
      result.length === 0 ||
      activeProject() !== undefined
    ) {
      return undefined;
    }
    if (params.projectId === pendingProjectRoute()) return undefined;
    return result[0]!.id;
  });

  function appendActivity(entry: Omit<ActivityEntry, "id" | "time">) {
    setActivities((current) =>
      [
        {
          ...entry,
          id: ++activityId,
          time: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        },
        ...current,
      ].slice(0, 8),
    );
  }

  async function runCommand(
    label: string,
    action: () => Promise<unknown>,
  ): Promise<boolean> {
    if (runningCommand() !== undefined) return false;
    setLocalError(undefined);
    setRunningCommand(label);
    const startedAt = performance.now();
    try {
      await action();
      appendActivity({
        kind: "command",
        title: label,
        detail: `Committed and settled in ${Math.max(1, Math.round(performance.now() - startedAt))}ms`,
      });
      return true;
    } catch (cause) {
      setLocalError(errorMessage(cause));
      return false;
    } finally {
      setRunningCommand(undefined);
    }
  }

  async function changeTaskStatus(taskId: string, status: TaskStatus) {
    await runCommand(`Move task to ${statusDetails[status].label}`, () =>
      moveTask.execute({ taskId, status }),
    );
  }

  async function changeAssignee(taskId: string, assigneeId: string | null) {
    await runCommand("Update task owner", () =>
      assignTask.execute({ taskId, assigneeId }),
    );
  }

  async function removeTask(taskId: string) {
    await runCommand("Delete task", () => deleteTask.execute({ taskId }));
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
    await runCommand(`Atomic sprint rebalance (${moves.length} writes)`, () =>
      rebalanceSprint.execute({ moves }),
    );
  }

  async function submitTask(event: SubmitEvent) {
    event.preventDefault();
    const project = activeProject();
    if (project === undefined) return;
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const success = await runCommand("Create task", () =>
      createTask.execute({
        id: crypto.randomUUID(),
        projectId: project.id,
        title: String(values.get("title") ?? ""),
        description: String(values.get("description") ?? ""),
        status: String(values.get("status") ?? "backlog") as TaskStatus,
        priority: Number(values.get("priority") ?? 2),
        assigneeId: String(values.get("assigneeId") ?? "") || null,
        createdAt: new Date(),
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
    const name = String(values.get("name") ?? "");
    const id = crypto.randomUUID();
    const success = await runCommand("Create project", () =>
      createProject.execute({
        id,
        ownerId: auth.userId()!,
        name,
        description: String(values.get("description") ?? ""),
        color: projectColors[name.length % projectColors.length]!,
        createdAt: new Date(),
      }),
    );
    if (success) {
      setPendingProjectRoute(id);
      navigate(`/projects/${id}`);
      form.reset();
      setShowProjectDialog(false);
    }
  }

  function signOut() {
    auth.signOut();
    navigate("/login", { replace: true });
  }

  return (
    <Show
      when={redirectProjectId()}
      fallback={
        <Show when={currentUser()} fallback={<Navigate href="/login" />}>
          {(person) => (
            <div class="app-shell">
              <Sidebar
                projects={projects()}
                activeProjectId={activeProject()?.id}
                currentUser={person()}
                myTaskCount={assignedTasks().length}
                materializations={materializationCount()}
                onCreateProject={() => setShowProjectDialog(true)}
                onSignOut={signOut}
              />
              <main class="workspace">
                <Topbar
                  search={search}
                  setSearch={setSearch}
                  team={members()}
                  placeholder={
                    location.pathname === "/team"
                      ? "Search team…"
                      : location.pathname === "/tasks"
                        ? "Search my tasks…"
                        : undefined
                  }
                />
                <Show
                  when={!loading()}
                  fallback={
                    <LoadingState error={localError() ?? queryError()} />
                  }
                >
                  <Switch>
                    <Match when={location.pathname === "/tasks"}>
                      <MyTasks
                        tasks={visibleAssignedTasks()}
                        onOpenProject={(projectId) =>
                          navigate(`/projects/${projectId}`)
                        }
                      />
                    </Match>
                    <Match when={location.pathname === "/team"}>
                      <TeamDirectory members={teamMembers()} />
                    </Match>
                    <Match when={activeProject()}>
                      <Show when={activeProject()}>
                        {(project) => (
                          <div class="content-grid">
                            <ProjectBoard
                              project={project()}
                              visibleTasks={visibleTasks()}
                              team={members()}
                              error={localError() ?? queryError()}
                              onDismissError={() => setLocalError(undefined)}
                              onRebalance={runRebalance}
                              onCreateTask={() => setShowTaskDialog(true)}
                              onMove={changeTaskStatus}
                              onAssign={changeAssignee}
                              onDelete={removeTask}
                            />
                            <Inspector
                              project={project()}
                              projectCount={projects().length}
                              totalTasks={totalTasks()}
                              completedTasks={completedTasks()}
                              activities={activities()}
                              runningCommand={runningCommand()}
                            />
                          </div>
                        )}
                      </Show>
                    </Match>
                  </Switch>
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
                          {members().map((member) => (
                            <option value={member.id}>{member.name}</option>
                          ))}
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
          )}
        </Show>
      }
    >
      {(projectId) => <Navigate href={`/projects/${projectId()}`} />}
    </Show>
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
          "Connecting to the policy gateway and materializing live queries…"}
      </p>
    </div>
  );
}

function errorMessage(cause: unknown): string | undefined {
  if (cause === undefined) return undefined;
  return cause instanceof Error ? cause.message : String(cause);
}
