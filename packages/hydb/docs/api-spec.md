# HyDB Consumer API

Status: Working draft

This document defines how application developers consume the database. Differential dataflow, storage internals, and wire implementation are intentionally outside its scope unless they affect public behavior.

## Design principles

- TypeScript is the primary authoring experience; the runtime remains usable from JavaScript.
- Schema objects are declared and exported independently, following the modular style of Drizzle ORM.
- Queries are declarative, typed, and serializable so the same plan can execute in the frontend or backend.
- Writes go through named transactors shared by frontend and backend.
- Frontend execution is an optimistic prediction; backend execution is authoritative.
- Differential weights and operators are internal details, not application write primitives.

## Packages

```text
hydb                   schema, query, transactor, and database definitions
@hydb/client           browser cache, synchronization, optimistic execution
@hydb/server           authority, persistence, and live query serving
@hydb/react            React provider and hooks
@hydb/memory           in-memory adapter for development and tests
```

## Schema

Schema definitions follow a Drizzle-like model. Each table is a standalone exported value, columns use typed builders, and table-level constraints and indexes are declared next to that table.

### Tables

```ts
// db/schema/users.ts
import {
  defineTable,
  id,
  string,
  timestamp,
  uniqueIndex,
} from 'hydb/schema'

export const users = defineTable(
  'users',
  {
    id: id().primaryKey(),
    name: string().notNull(),
    email: string().notNull(),
    createdAt: timestamp().notNull(),
  },
  table => [
    uniqueIndex('users_email_unique').on(table.email),
  ],
)
```

```ts
// db/schema/projects.ts
import {
  boolean,
  defineTable,
  id,
  index,
  string,
  timestamp,
} from 'hydb/schema'
import {users} from './users'

export const projects = defineTable(
  'projects',
  {
    id: id().primaryKey(),

    ownerId: id()
      .notNull()
      .references(() => users.id),

    name: string().notNull(),
    archived: boolean().notNull().default(false),
    createdAt: timestamp().notNull(),
  },
  table => [
    index('projects_owner_idx').on(table.ownerId),
  ],
)
```

```ts
// db/schema/tasks.ts
import {
  defineTable,
  enumeration,
  id,
  index,
  integer,
  string,
  timestamp,
} from 'hydb/schema'
import {projects} from './projects'
import {users} from './users'

export const taskStatus = enumeration('task_status', [
  'todo',
  'doing',
  'done',
])

export const tasks = defineTable(
  'tasks',
  {
    id: id().primaryKey(),

    projectId: id()
      .notNull()
      .references(() => projects.id),

    assigneeId: id()
      .references(() => users.id),

    title: string().notNull(),
    status: taskStatus().notNull().default('todo'),
    priority: integer().notNull().default(0),
    createdAt: timestamp().notNull(),
  },
  table => [
    index('tasks_project_idx').on(table.projectId),
    index('tasks_assignee_idx').on(table.assigneeId),
    index('tasks_project_status_idx').on(
      table.projectId,
      table.status,
    ),
  ],
)
```

Tables can live in separate files, be grouped by domain, and import one another for foreign-key declarations. There is no required singular schema object containing every table definition.

### Column builders

Initial column builders:

```text
id()
string()
integer()
number()
boolean()
timestamp()
json(schema?)
enumeration(name, values)
```

Common modifiers:

```text
.primaryKey()
.notNull()
.default(value)
.references(() => anotherTable.column)
```

Defaults must be serializable constants or engine-defined expressions. Arbitrary functions are not allowed because schema definitions must behave consistently across environments.

```ts
createdAt: timestamp()
  .notNull()
  .default(sql.now())
```

### Inferred types

Each table carries its row, insert, and update types:

```ts
import type {
  InferInsert,
  InferRow,
  InferUpdate,
} from 'hydb/schema'
import {tasks} from './schema/tasks'

export type Task = InferRow<typeof tasks>
export type NewTask = InferInsert<typeof tasks>
export type TaskPatch = InferUpdate<typeof tasks>
```

Expected inference:

```ts
type Task = {
  id: string
  projectId: string
  assigneeId: string | null
  title: string
  status: 'todo' | 'doing' | 'done'
  priority: number
  createdAt: Date
}

type NewTask = {
  id: string
  projectId: string
  assigneeId?: string | null
  title: string
  status?: 'todo' | 'doing' | 'done'
  priority?: number
  createdAt: Date
}
```

Primary keys are immutable and therefore absent from `InferUpdate`.

### Relations

Relations are declared separately from physical tables so circular imports do not force every table into one object. They provide typed query traversal; foreign keys remain the source of referential integrity.

```ts
// db/schema/relations.ts
import {defineRelations} from 'hydb/schema'
import {projects} from './projects'
import {tasks} from './tasks'
import {users} from './users'

export const projectRelations = defineRelations(
  projects,
  ({one, many}) => ({
    owner: one(users, {
      fields: [projects.ownerId],
      references: [users.id],
    }),

    tasks: many(tasks),
  }),
)

export const taskRelations = defineRelations(
  tasks,
  ({one}) => ({
    project: one(projects, {
      fields: [tasks.projectId],
      references: [projects.id],
    }),

    assignee: one(users, {
      fields: [tasks.assigneeId],
      references: [users.id],
    }),
  }),
)
```

### Schema module discovery

The database definition accepts a module namespace, matching the common Drizzle pattern:

```ts
// db/schema/index.ts
export * from './users'
export * from './projects'
export * from './tasks'
export * from './relations'
```

```ts
// db/app.ts
import * as schema from './schema'
import {hydb} from 'hydb'

export const appDatabase = hydb.database({
  name: 'project-manager',
  version: 1,
  schema,
})
```

`hydb.database` discovers branded table, enum, and relation objects exported by the module. Unrelated exports are ignored. Duplicate physical table or enum names are rejected during initialization.

This assembly point supplies the complete schema for runtime validation, migrations, query construction, and manifest generation without requiring tables to be authored in a central object.

### Schema identity and compatibility

The build produces a canonical schema manifest and hash from the assembled exports:

```text
database name
schema version
tables and columns
primary and foreign keys
indexes
enumerations
relations
canonical schema hash
```

Clients include the schema version and hash during synchronization. The backend rejects an incompatible client before accepting queries or mutations.

## Shared transactors

Transactors are named commands imported by both frontend and backend. The frontend may execute them optimistically, but the backend alone authorizes and commits them.

### Definition

Each transactor is an independently exported value created with `hydb.transactor`. Like tables, transactors can be organized by domain instead of collected into one large registry object.

```ts
// db/transactors/tasks.ts
import {hydb} from 'hydb'
import {z} from 'zod'
import {projects, tasks} from '../schema'

export const createTask = hydb.transactor({
  name: 'tasks.create',

  input: z.object({
    id: z.string(),
    projectId: z.string(),
    title: z.string().trim().min(1),
  }),

  async run({tx, input}) {
    const project = await tx
      .from(projects)
      .where(projects.id.eq(input.projectId))
      .one()

    if (!project) {
      throw hydb.error('PROJECT_NOT_FOUND')
    }

    if (project.archived) {
      throw hydb.error('PROJECT_ARCHIVED')
    }

    await tx.insert(tasks).values({
      id: input.id,
      projectId: input.projectId,
      title: input.title,
      status: 'todo',
      priority: 0,
      createdAt: tx.now,
    })
  },
})
```

`input` accepts a Standard Schema-compatible validator. Zod is shown here, but HyDB does not require it. The validator supplies runtime validation and inferred input types.

```ts
type CreateTaskInput = typeof createTask.Input
```

The transactor name is its stable wire identity. Names must be unique within a database and should remain stable across code refactors.

### Transaction context

`run` receives one object containing the transaction and validated input:

```ts
type TransactorContext<Input, Auth> = {
  tx: HyDBTransaction<Auth>
  input: Input
}
```

The transaction provides:

```ts
tx.auth       // authenticated application context
tx.now        // stable timestamp assigned to this invocation
tx.location   // 'client' | 'server'

tx.from(table)
tx.insert(table)
tx.update(table)
tx.delete(table)
```

`tx.now` is fixed for the entire invocation and is sent with the mutation so optimistic and authoritative execution observe the same value.

### Reads

Transactor reads use the same typed query expressions as normal reads:

```ts
const task = await tx
  .from(tasks)
  .where(tasks.id.eq(input.taskId))
  .one()
```

Available result operators:

```ts
.all()       // zero or more rows
.one()       // zero or one row; errors if multiple rows match
.require()   // exactly one row; errors if zero or multiple match
.exists()    // boolean
```

Reads and writes within one transactor observe a consistent transaction state. Later reads observe earlier writes from the same invocation.

The frontend can only read rows currently present in its cache. A missing local row is therefore not proof that the authoritative row is absent.

HyDB distinguishes these outcomes internally:

```text
found                 row is present
known absent          cached query coverage proves no row exists
unknown               local cache cannot answer authoritatively
```

If a transactor branches on an `unknown` read, optimistic execution stops and returns `not-predicted`. The mutation is still sent to the backend, where the same transactor runs against complete authoritative data.

```ts
const outcome = db.transact(createTask, input)

await outcome.local
// {status: 'applied'}
// {status: 'not-predicted', reason: 'missing-data'}
// {status: 'rejected', error}
```

This behavior is automatic. Developers do not treat an incomplete frontend cache as a business-rule failure.

### Writes

Writes use table objects, so inserted and updated values are inferred from the schema.

```ts
await tx.insert(tasks).values({
  id: input.id,
  projectId: input.projectId,
  title: input.title,
  status: 'todo',
  priority: 0,
  createdAt: tx.now,
})
```

```ts
await tx
  .update(tasks)
  .set({status: 'done'})
  .where(tasks.id.eq(input.taskId))
```

```ts
await tx
  .delete(tasks)
  .where(tasks.id.eq(input.taskId))
```

An update or delete that matches no rows is a successful no-op unless the transactor explicitly reads with `.require()` first.

All writes are atomic. If validation fails, `run` throws, or authority rejects the mutation, none of its authoritative writes commit.

### Determinism

Shared execution requires deterministic behavior. Transactors may use values supplied by `tx`:

```ts
tx.now
tx.auth
tx.location
```

Application code should generate stable entity IDs before invoking a transactor:

```ts
db.transact(createTask, {
  id: crypto.randomUUID(),
  projectId,
  title,
})
```

The shared `run` function must not directly depend on nondeterministic or environment-specific effects:

```text
Date.now()
Math.random()
fetch()
filesystem access
process.env
mutable module globals
```

External effects belong in server-side workflows triggered after a committed mutation, not inside the shared transaction.

### Authorization

Business invariants that can run identically in both locations stay in `run`. Server-only authority checks use an optional `authorize` hook:

```ts
export const deleteProject = hydb.transactor({
  name: 'projects.delete',

  input: z.object({
    projectId: z.string(),
  }),

  authorize({auth, input}) {
    if (auth.role !== 'admin') {
      throw hydb.error('FORBIDDEN')
    }
  },

  async run({tx, input}) {
    await tx
      .delete(projects)
      .where(projects.id.eq(input.projectId))
  },
})
```

`authorize` runs only on the backend and cannot produce database writes. Its outcome is never trusted from the frontend.

If authorization depends on database rows, the transactor performs those checks inside `run`; the backend execution remains authoritative even if the frontend predicts the same decision.

### Errors

Expected business failures use stable serializable error codes:

```ts
throw hydb.error('PROJECT_ARCHIVED', {
  projectId: input.projectId,
})
```

Consumer handling:

```ts
const result = await db
  .transact(createTask, input)
  .server

if (
  result.status === 'rejected' &&
  result.error.code === 'PROJECT_ARCHIVED'
) {
  showArchivedProjectMessage()
}
```

Unexpected thrown values become a generic internal error at the protocol boundary. Server stack traces and private messages are not sent to clients.

### Invocation and lifecycle

The client invokes the exported definition directly:

```ts
const mutation = db.transact(createTask, {
  id: crypto.randomUUID(),
  projectId,
  title: 'Write the API specification',
})
```

The returned handle exposes separate local and authoritative outcomes:

```ts
type LocalMutationResult =
  | {status: 'applied'}
  | {status: 'not-predicted'; reason: 'missing-data'}
  | {status: 'rejected'; error: HyDBError}

type ServerMutationResult =
  | {status: 'committed'; version: bigint}
  | {status: 'rejected'; error: HyDBError}

mutation.local: Promise<LocalMutationResult>
mutation.server: Promise<ServerMutationResult>
```

Calls are fire-and-forget by default:

```ts
db.transact(completeTask, {taskId})
```

Applications can await server confirmation when the workflow requires it:

```ts
const result = await db
  .transact(completeTask, {taskId})
  .server
```

The optimistic result remains visible while the mutation is pending. When the server commits or rejects it, HyDB removes that prediction, applies authoritative changes, and replays later pending transactors in client order.

### Transactor module discovery

Transactors are exported through a module namespace:

```ts
// db/transactors/index.ts
export * from './projects'
export * from './tasks'
```

```ts
// db/app.ts
import {hydb} from 'hydb'
import * as schema from './schema'
import * as transactors from './transactors'

export const appDatabase = hydb.database({
  name: 'project-manager',
  version: 1,
  schema,
  transactors,
})
```

`hydb.database` discovers branded transactor definitions in the module and rejects duplicate names. The generated database manifest includes each name and input-schema identity so clients and servers can detect incompatible bundles.

### Backend invocation

Server jobs, webhooks, and tests invoke the same definition with explicit auth context:

```ts
const result = await server.transact(
  createTask,
  {
    id: 't1',
    projectId: 'p1',
    title: 'Imported task',
  },
  {
    auth: {
      userId: 'system',
      role: 'system',
    },
  },
)
```

Backend invocation runs once authoritatively and returns the server result. It does not create an optimistic layer.

## Queries

Frontend queries are typed declarative expressions that compile to a serializable plan. The local and server runtimes execute the same plan.

Working direction:

```ts
const openTasks = db.query(tasks)
  .where(task => task.projectId.eq(projectId))
  .where(task => task.status.ne('done'))
  .orderBy(task => task.priority.desc())
  .limit(50)
```

The callback syntax above is an expression-building API, not arbitrary JavaScript execution. Its exact restrictions and alternative forms remain to be decided.

## Client and server

Working direction:

```ts
const client = createClient({
  database: appDatabase,
  sync: {url, getAuth},
  storage: indexedDBStorage(),
})
```

```ts
const server = createServer({
  database: appDatabase,
  storage,
  authenticate,
})
```

## Open API decisions

- Whether standard CRUD transactors are generated, opt-in, or always explicit.
- Whether `authorize` should remain a separate server-only hook or authority should always be expressed inside `run`.
- Whether `.update()` and `.delete()` should be no-ops on zero matches or return an affected-row count.
- How transactor bundle compatibility works during rolling deployments.
- Query expression syntax, variables, joins, aggregates, and relation loading.
- Read-policy definition and composition.
- Local, remote, and hybrid query placement defaults.
- Mutation result and reconciliation status APIs.
- Framework bindings and lifecycle behavior.
