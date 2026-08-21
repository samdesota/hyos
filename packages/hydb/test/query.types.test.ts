import {
  boolean,
  hydb,
  id,
  integer,
  text,
  type InferQueryResult,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

type Expect<Value extends true> = Value;
type SimplifyDeep<Value> = Value extends readonly (infer Item)[]
  ? SimplifyDeep<Item>[]
  : Value extends object
    ? { [Key in keyof Value]: SimplifyDeep<Value[Key]> }
    : Value;

const taskStatus = hydb.enum("task_status", ["todo", "doing", "done"]);

const users = hydb.table("users", {
  id: id().primaryKey(),
  name: text().notNull(),
});

const projects = hydb.table("projects", {
  id: id().primaryKey(),
  name: text().notNull(),
  archived: boolean().notNull().default(false),
});

const tasks = hydb.table("tasks", {
  id: id().primaryKey(),
  projectId: id()
    .notNull()
    .references(() => projects.id),
  assigneeId: id().references(() => users.id),
  title: text().notNull(),
  status: taskStatus().notNull().default("todo"),
  priority: integer().notNull().default(0),
});

const projectDetails = hydb
  .query(projects)
  .where((project) => project.id.eq("project-1"))
  .select((project) => ({
    id: project.id,
    name: project.name,
    archived: project.archived,

    tasks: hydb
      .query(tasks)
      .where((task) => task.projectId.eq(project.id))
      .orderBy((task) => [task.priority.desc(), task.id.asc()])
      .select((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,

        assignee: hydb
          .query(users)
          .where((user) => task.assigneeId.eq(user.id))
          .select((user) => ({
            id: user.id,
            name: user.name,
          }))
          .one(),
      }))
      .many(),

    openTaskCount: hydb
      .query(tasks)
      .where((task) =>
        task.projectId.eq(project.id).and(task.status.ne("done")),
      )
      .count(),

    hasTasks: hydb
      .query(tasks)
      .where((task) => task.projectId.eq(project.id))
      .exists(),
  }))
  .one();

type ExpectedProjectDetails = {
  id: string;
  name: string;
  archived: boolean;
  tasks: Array<{
    id: string;
    title: string;
    status: "todo" | "doing" | "done";
    assignee: {
      id: string;
      name: string;
    } | null;
  }>;
  openTaskCount: number;
  hasTasks: boolean;
} | null;

type ProjectDetailsMatches = Expect<
  Equal<
    SimplifyDeep<InferQueryResult<typeof projectDetails>>,
    ExpectedProjectDetails
  >
>;

const allTasks = hydb.query(tasks).many();
type AllTasksMatch = Expect<
  Equal<
    SimplifyDeep<InferQueryResult<typeof allTasks>>,
    Array<{
      id: string;
      projectId: string;
      assigneeId: string | null;
      title: string;
      status: "todo" | "doing" | "done";
      priority: number;
    }>
  >
>;

const requiredProject = hydb
  .query(projects)
  .where((project) => project.id.eq("project-1"))
  .require();

type RequiredProjectMatches = Expect<
  Equal<
    SimplifyDeep<InferQueryResult<typeof requiredProject>>,
    { id: string; name: string; archived: boolean }
  >
>;

hydb.query(projects).where((project) => {
  // @ts-expect-error column comparisons reject incompatible values
  return project.id.eq(123);
});

hydb.query(tasks).where((task) => {
  // @ts-expect-error enum comparisons reject values outside the enum
  return task.status.eq("blocked");
});

void (null as unknown as ProjectDetailsMatches);
void (null as unknown as AllTasksMatch);
void (null as unknown as RequiredProjectMatches);
