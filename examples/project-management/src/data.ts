import {
  hydb,
  id,
  index,
  integer,
  text,
  timestamp,
  type InferQueryResult,
} from "@hyos/hydb";
import { hyapp } from "@hyos/hyapp";
import { z } from "zod";

export const taskStatuses = ["backlog", "in_progress", "done"] as const;
export type TaskStatus = (typeof taskStatuses)[number];

const taskStatus = hydb.enum("project_task_status", taskStatuses);

export const users = hydb.table("demo_users", {
  id: id().primaryKey(),
  name: text().notNull(),
  initials: text().notNull(),
  color: text().notNull(),
});

export const projects = hydb.table(
  "demo_projects",
  {
    id: id().primaryKey(),
    ownerId: id()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    description: text().notNull(),
    color: text().notNull(),
    createdAt: timestamp().notNull(),
  },
  (columns) => [index("demo_projects_owner_idx").on(columns.ownerId)],
);

export const tasks = hydb.table(
  "demo_tasks",
  {
    id: id().primaryKey(),
    projectId: id()
      .notNull()
      .references(() => projects.id),
    assigneeId: id().references(() => users.id),
    title: text().notNull(),
    description: text().notNull().default(""),
    status: taskStatus().notNull().default("backlog"),
    priority: integer().notNull().default(1),
    createdAt: timestamp().notNull(),
  },
  (columns) => [index("demo_tasks_project_idx").on(columns.projectId)],
);

export const demoSchema = hydb.schema({ users, projects, tasks });

export const principalSchema = z.object({ userId: z.string().min(1) });
export type Principal = z.output<typeof principalSchema>;

export const projectBoardQuery = hydb
  .query(projects)
  .orderBy((project) => project.createdAt.asc())
  .select((project) => ({
    id: project.id,
    name: project.name,
    description: project.description,
    color: project.color,
    createdAt: project.createdAt,
    tasks: hydb
      .query(tasks)
      .where((task) => task.projectId.eq(project.id))
      .orderBy((task) => [task.priority.desc(), task.createdAt.asc()])
      .select((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        createdAt: task.createdAt,
        assignee: hydb
          .query(users)
          .where((user) => task.assigneeId.eq(user.id))
          .select((user) => ({
            id: user.id,
            name: user.name,
            initials: user.initials,
            color: user.color,
          }))
          .one(),
      }))
      .many(),
    openCount: hydb
      .query(tasks)
      .where((task) => task.projectId.eq(project.id))
      .where((task) => task.status.ne("done"))
      .count(),
    completedCount: hydb
      .query(tasks)
      .where((task) => task.projectId.eq(project.id))
      .where((task) => task.status.eq("done"))
      .count(),
  }))
  .many();

export const teamQuery = hydb
  .query(users)
  .orderBy((user) => user.name.asc())
  .many();

export const readRegistry = hyapp.gatewayReadRegistry({
  projectBoard: projectBoardQuery,
  team: teamQuery,
});

export type ProjectBoard = InferQueryResult<typeof projectBoardQuery>;
export type ProjectView = ProjectBoard[number];
export type TaskView = ProjectView["tasks"][number];
export type Team = InferQueryResult<typeof teamQuery>;

const reads = hydb.readPolicy(principalSchema);
export const readPolicies = Object.freeze([
  reads.allowAll(users),
  reads.where(projects, ({ row, principal }) =>
    row.ownerId.eq(principal.userId),
  ),
  reads.through(tasks, projects, {
    from: tasks.projectId,
    to: projects.id,
  }),
]);

const writes = hydb.writePolicy(principalSchema);
export const writePolicies = Object.freeze([
  writes.denyAll(users),
  writes.where(projects, ({ change, principal }) => {
    const ownsBefore =
      change.kind === "insert" || change.before.ownerId === principal.userId;
    const ownsAfter =
      change.kind === "delete" || change.after.ownerId === principal.userId;
    return ownsBefore && ownsAfter;
  }),
  writes.through(tasks, projects, {
    from: tasks.projectId,
    to: projects.id,
  }),
]);

const commands = hyapp.commandFactory({
  principal: principalSchema,
  defaultPolicy: writePolicies,
});
const identifierResult = z.object({ id: z.string() });

export const createProject = commands.define({
  input: z.object({
    id: z.string().min(1),
    ownerId: z.string().min(1),
    name: z.string().trim().min(2).max(48),
    description: z.string().trim().max(140).default(""),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    createdAt: z.date(),
  }),
  output: identifierResult,
  async optimistic({ transaction }, input) {
    await transaction.insert(projects, input);
  },
  async server({ applyOptimistic }, input) {
    await applyOptimistic();
    return { id: input.id };
  },
});

export const createTask = commands.define({
  input: z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().trim().min(2).max(100),
    description: z.string().trim().max(240).default(""),
    status: z.enum(taskStatuses).default("backlog"),
    priority: z.number().int().min(1).max(4).default(2),
    assigneeId: z.string().nullable().default(null),
    createdAt: z.date(),
  }),
  output: identifierResult,
  async optimistic({ transaction }, input) {
    await transaction.insert(tasks, input);
  },
  async server({ applyOptimistic }, input) {
    await applyOptimistic();
    return { id: input.id };
  },
});

export const moveTask = commands.define({
  input: z.object({
    taskId: z.string().min(1),
    status: z.enum(taskStatuses),
  }),
  output: identifierResult,
  async optimistic({ transaction }, input) {
    await transaction.update(tasks, [input.taskId], { status: input.status });
  },
  async server({ applyOptimistic }, input) {
    await applyOptimistic();
    return { id: input.taskId };
  },
});

export const assignTask = commands.define({
  input: z.object({
    taskId: z.string().min(1),
    assigneeId: z.string().nullable(),
  }),
  output: identifierResult,
  async optimistic({ transaction }, input) {
    await transaction.update(tasks, [input.taskId], {
      assigneeId: input.assigneeId,
    });
  },
  async server({ applyOptimistic }, input) {
    await applyOptimistic();
    return { id: input.taskId };
  },
});

export const deleteTask = commands.define({
  input: z.object({ taskId: z.string().min(1) }),
  output: identifierResult,
  async optimistic({ transaction }, input) {
    await transaction.delete(tasks, [input.taskId]);
  },
  async server({ applyOptimistic }, input) {
    await applyOptimistic();
    return { id: input.taskId };
  },
});

export const rebalanceSprint = commands.define({
  input: z.object({
    moves: z
      .array(
        z.object({ taskId: z.string().min(1), status: z.enum(taskStatuses) }),
      )
      .min(1),
  }),
  output: z.object({ updated: z.number().int().nonnegative() }),
  async optimistic({ transaction }, input) {
    for (const move of input.moves) {
      await transaction.update(tasks, [move.taskId], { status: move.status });
    }
  },
  async server({ applyOptimistic }, input) {
    await applyOptimistic();
    return { updated: input.moves.length };
  },
});

export const commandRegistry = hyapp.commandRegistry({
  createProject,
  createTask,
  moveTask,
  assignTask,
  deleteTask,
  rebalanceSprint,
});
