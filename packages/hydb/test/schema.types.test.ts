import {
  boolean,
  hydb,
  id,
  index,
  integer,
  json,
  text,
  timestamp,
  uniqueIndex,
  type InferInsert,
  type InferRow,
  type InferUpdate,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

type Expect<Value extends true> = Value;
type Simplify<Value> = { [Key in keyof Value]: Value[Key] };

const taskStatus = hydb.enum("task_status", ["todo", "doing", "done"]);

const projects = hydb.table(
  "projects",
  {
    id: id().primaryKey(),
    name: text().notNull(),
    archived: boolean().notNull().default(false),
  },
  (project) => [uniqueIndex("projects_name_unique").on(project.name)],
);

const tasks = hydb.table(
  "tasks",
  {
    id: id().primaryKey(),
    projectId: id()
      .notNull()
      .references(() => projects.id),
    title: text().notNull(),
    status: taskStatus().notNull().default("todo"),
    priority: integer().notNull().default(0),
    metadata: json<{ source: string }>(),
    createdAt: timestamp().notNull(),
  },
  (task) => [
    index("tasks_project_idx").on(task.projectId),
    index("tasks_project_status_idx").on(task.projectId, task.status),
  ],
);

hydb.schema({ projects, tasks });

type ExpectedTask = {
  id: string;
  projectId: string;
  title: string;
  status: "todo" | "doing" | "done";
  priority: number;
  metadata: { source: string } | null;
  createdAt: Date;
};

type ExpectedTaskInsert = {
  id: string;
  projectId: string;
  title: string;
  status?: "todo" | "doing" | "done";
  priority?: number;
  metadata?: { source: string } | null;
  createdAt: Date;
};

type ExpectedTaskUpdate = {
  projectId?: string;
  title?: string;
  status?: "todo" | "doing" | "done";
  priority?: number;
  metadata?: { source: string } | null;
  createdAt?: Date;
};

type RowMatches = Expect<Equal<Simplify<InferRow<typeof tasks>>, ExpectedTask>>;
type InsertMatches = Expect<
  Equal<Simplify<InferInsert<typeof tasks>>, ExpectedTaskInsert>
>;
type UpdateMatches = Expect<
  Equal<Simplify<InferUpdate<typeof tasks>>, ExpectedTaskUpdate>
>;

const insert: InferInsert<typeof tasks> = {
  id: "task-1",
  projectId: "project-1",
  title: "Build schema builder",
  createdAt: new Date(),
};

const update: InferUpdate<typeof tasks> = {
  status: "doing",
  metadata: null,
};

// @ts-expect-error required fields cannot be omitted
const missingTitle: InferInsert<typeof tasks> = {
  id: "task-1",
  projectId: "project-1",
  createdAt: new Date(),
};

// @ts-expect-error primary keys cannot be updated
const updatesPrimaryKey: InferUpdate<typeof tasks> = { id: "task-2" };

// @ts-expect-error enum values remain a literal union
const invalidStatus: InferUpdate<typeof tasks> = { status: "blocked" };

void (null as unknown as RowMatches);
void (null as unknown as InsertMatches);
void (null as unknown as UpdateMatches);
void insert;
void update;
void missingTitle;
void updatesPrimaryKey;
void invalidStatus;
