import {
  hydb,
  id,
  integer,
  memoryStorage,
  text,
  timestamp,
  type Database,
  type InferQueryResult,
} from "@hyos/hydb";
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

export const projects = hydb.table("demo_projects", {
  id: id().primaryKey(),
  name: text().notNull(),
  description: text().notNull(),
  color: text().notNull(),
  createdAt: timestamp().notNull(),
});

export const tasks = hydb.table("demo_tasks", {
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
});

export const demoSchema = hydb.schema({ users, projects, tasks });

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

export type ProjectBoard = InferQueryResult<typeof projectBoardQuery>;
export type ProjectView = ProjectBoard[number];
export type TaskView = ProjectView["tasks"][number];
export type Team = InferQueryResult<typeof teamQuery>;

const projectColors = ["#6c5ce7", "#e17055", "#00a884", "#2d7ff9"];

export const createProject = hydb.command({
  input: z.object({
    name: z.string().trim().min(2).max(48),
    description: z.string().trim().max(140).default(""),
  }),
  handler: (tx, input) => {
    const id = crypto.randomUUID();
    return tx.insert(projects, {
      id,
      name: input.name,
      description: input.description,
      color: projectColors[input.name.length % projectColors.length]!,
      createdAt: new Date(),
    });
  },
});

export const createTask = hydb.command({
  input: z.object({
    projectId: z.string().min(1),
    title: z.string().trim().min(2).max(100),
    description: z.string().trim().max(240).default(""),
    status: z.enum(taskStatuses).default("backlog"),
    priority: z.number().int().min(1).max(4).default(2),
    assigneeId: z.string().nullable().default(null),
  }),
  handler: (tx, input) =>
    tx.insert(tasks, {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      assigneeId: input.assigneeId,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      createdAt: new Date(),
    }),
});

export const moveTask = hydb.command({
  input: z.object({
    taskId: z.string().min(1),
    status: z.enum(taskStatuses),
  }),
  handler: (tx, input) =>
    tx.update(tasks, [input.taskId], { status: input.status }),
});

export const assignTask = hydb.command({
  input: z.object({
    taskId: z.string().min(1),
    assigneeId: z.string().nullable(),
  }),
  handler: (tx, input) =>
    tx.update(tasks, [input.taskId], { assigneeId: input.assigneeId }),
});

export const deleteTask = hydb.command({
  input: z.object({ taskId: z.string().min(1) }),
  handler: (tx, input) => tx.delete(tasks, [input.taskId]),
});

export const rebalanceSprint = hydb.command({
  input: z.object({
    moves: z
      .array(
        z.object({ taskId: z.string().min(1), status: z.enum(taskStatuses) }),
      )
      .min(1),
  }),
  handler: async (tx, input) => {
    for (const move of input.moves) {
      await tx.update(tasks, [move.taskId], { status: move.status });
    }
    return input.moves.length;
  },
});

const seedDemo = hydb.command({
  input: z.undefined(),
  handler: async (tx) => {
    for (const user of [
      { id: "user-maya", name: "Maya Chen", initials: "MC", color: "#7257d9" },
      { id: "user-jon", name: "Jon Bell", initials: "JB", color: "#e17055" },
      { id: "user-nia", name: "Nia Okafor", initials: "NO", color: "#008f72" },
      { id: "user-luca", name: "Luca Reyes", initials: "LR", color: "#2d7ff9" },
    ]) {
      await tx.insert(users, user);
    }

    const seededProjects = [
      {
        id: "project-hydb",
        name: "HyDB launch",
        description: "Ship the first fast, reactive local database experience.",
        color: "#6c5ce7",
        createdAt: new Date("2026-08-01T09:00:00Z"),
      },
      {
        id: "project-studio",
        name: "Studio refresh",
        description: "A calmer visual system for the HyOS workspace.",
        color: "#e17055",
        createdAt: new Date("2026-08-05T09:00:00Z"),
      },
      {
        id: "project-docs",
        name: "Developer docs",
        description: "Turn the prototype into a story developers can follow.",
        color: "#00a884",
        createdAt: new Date("2026-08-10T09:00:00Z"),
      },
    ];
    for (const project of seededProjects) await tx.insert(projects, project);

    const seededTasks: Array<{
      id: string;
      projectId: string;
      assigneeId: string | null;
      title: string;
      description: string;
      status: TaskStatus;
      priority: number;
      createdAt: Date;
    }> = [
      [
        "ddf",
        "project-hydb",
        "user-maya",
        "Harden incremental joins",
        "Exercise re-keying and nested defaults.",
        "in_progress",
        4,
      ],
      [
        "commands",
        "project-hydb",
        "user-jon",
        "Design command ergonomics",
        "Keep tricky writes out of components.",
        "done",
        4,
      ],
      [
        "bench",
        "project-hydb",
        "user-nia",
        "Build browser benchmark",
        "Measure update propagation under load.",
        "backlog",
        3,
      ],
      [
        "storage",
        "project-hydb",
        "user-luca",
        "Prototype persistent adapter",
        "Map the storage seam onto IndexedDB.",
        "backlog",
        2,
      ],
      [
        "tokens",
        "project-studio",
        "user-maya",
        "Consolidate color tokens",
        "Reduce one-off values across surfaces.",
        "in_progress",
        3,
      ],
      [
        "nav",
        "project-studio",
        "user-luca",
        "Polish workspace navigation",
        "Improve density and active states.",
        "done",
        2,
      ],
      [
        "empty",
        "project-studio",
        null,
        "Design empty states",
        "Make new workspaces feel intentional.",
        "backlog",
        1,
      ],
      [
        "quickstart",
        "project-docs",
        "user-nia",
        "Write five-minute quickstart",
        "Schema to live query in one page.",
        "in_progress",
        4,
      ],
      [
        "commands-doc",
        "project-docs",
        "user-jon",
        "Document command handlers",
        "Explain Zod validation and atomicity.",
        "backlog",
        3,
      ],
      [
        "diagram",
        "project-docs",
        null,
        "Diagram the dataflow graph",
        "Show operators and weighted updates.",
        "backlog",
        2,
      ],
    ].map(
      (
        [id, projectId, assigneeId, title, description, status, priority],
        index,
      ) => ({
        id: String(id),
        projectId: String(projectId),
        assigneeId: assigneeId === null ? null : String(assigneeId),
        title: String(title),
        description: String(description),
        status: status as TaskStatus,
        priority: Number(priority),
        createdAt: new Date(Date.UTC(2026, 7, 11 + index, 9, 0, 0)),
      }),
    );
    for (const task of seededTasks) await tx.insert(tasks, task);
  },
});

export async function createDemoDatabase(): Promise<Database> {
  const storage = await memoryStorage({ schema: demoSchema });
  const database = await hydb.database({ schema: demoSchema, storage });
  await database.execute(seedDemo, undefined);
  return database;
}
