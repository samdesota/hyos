# HyApp usage guide

HyApp is the application layer on top of HyDB. HyDB owns schemas, queries,
transactions, policies, and storage. HyApp adds commands, principal-bound
gateways, typed clients, HTTP transport, command compilation, and optional UI
helpers.

This guide builds a small project/task application from the database through a
Solid client. The examples use the public package entry points:

```ts
import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";
import { hyapp } from "@hyos/hyapp";
import { httpGatewayTransport } from "@hyos/hyapp/http";
import { createNodeGatewayHttpHandler } from "@hyos/hyapp/node";
import { createCommandDispatcher, createGatewayQuery } from "@hyos/hyapp/solid";
```

## 1. Define the HyDB schema

A table needs a primary key. Columns may be nullable, required, defaulted, or
foreign-key references. Index relationship columns that will be filtered or
joined frequently.

```ts
// model.ts
import { boolean, hydb, id, index, text, timestamp } from "@hyos/hydb";

export const users = hydb.table("users", {
  id: id().primaryKey(),
  name: text().notNull(),
});

export const projects = hydb.table(
  "projects",
  {
    id: id().primaryKey(),
    ownerId: id()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    createdAt: timestamp().notNull(),
  },
  (columns) => [index("projects_owner_idx").on(columns.ownerId)],
);

export const tasks = hydb.table(
  "tasks",
  {
    id: id().primaryKey(),
    projectId: id()
      .notNull()
      .references(() => projects.id),
    title: text().notNull(),
    done: boolean().notNull().default(false),
    createdAt: timestamp().notNull(),
  },
  (columns) => [index("tasks_project_idx").on(columns.projectId)],
);

export const appSchema = hydb.schema({ users, projects, tasks });
```

HyDB also exports `integer`, `number`, `json`, `uniqueIndex`, and
`hydb.enum(name, values)` for typed string enums.

## 2. Define the authenticated principal

The same Zod schema instance is used by read policies, write policies, command
factories, and the gateway. This is intentional: startup validation rejects a
policy or command created for a different principal schema.

```ts
import { z } from "zod";

export const principalSchema = z.object({
  userId: z.string().min(1),
});

export type Principal = z.output<typeof principalSchema>;
```

Authentication is outside HyApp. An HTTP adapter converts an authenticated
request into this principal later in the guide.

## 3. Define typed queries

Queries are values, not endpoint handlers. They can be fetched, subscribed to,
nested, and shared between server and client builds.

```ts
import { hydb, type InferQueryResult } from "@hyos/hydb";

export const projectBoardQuery = hydb
  .query(projects)
  .orderBy((project) => project.createdAt.desc())
  .select((project) => ({
    id: project.id,
    name: project.name,
    tasks: hydb
      .query(tasks)
      .where((task) => task.projectId.eq(project.id))
      .orderBy((task) => task.createdAt.asc())
      .select((task) => ({
        id: task.id,
        title: task.title,
        done: task.done,
      }))
      .many(),
    openTaskCount: hydb
      .query(tasks)
      .where((task) => task.projectId.eq(project.id))
      .where((task) => task.done.eq(false))
      .count(),
  }))
  .many();

export type ProjectBoard = InferQueryResult<typeof projectBoardQuery>;
```

A query ends with `.many()`, `.one()`, or `.count()`. Selection fields preserve
their TypeScript result types. The query builder also supports comparison and
logical expressions, multiple `where` clauses, and ascending or descending
ordering.

Give every remotely accessible query a stable wire name:

```ts
export const readRegistry = hyapp.gatewayReadRegistry({
  projectBoard: projectBoardQuery,
});
```

The HTTP adapter only accepts queries present in this registry. Application
code still uses the query value directly, so `fetch(projectBoardQuery)` retains
its inferred result type.

## 4. Define read policies

Policies are row filters applied by the gateway before a query reaches the
database. Define exactly one read policy for every table in the schema.

```ts
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
```

This means:

- every authenticated principal can read users;
- a principal can read only projects they own; and
- a task is readable only through its readable parent project.

`allowAll(table)` and `denyAll(table)` are explicit. `where(table, predicate)`
adds a principal-dependent expression. `through(child, parent, relationship)`
inherits access from a parent whose target is its single-column primary key.

Policy enforcement is fail-closed: missing, duplicate, out-of-schema, or
principal-mismatched policies reject gateway construction. A nested task query
correlated to an already authorized project can reuse that authorization fact;
the planner does not need to emit a redundant existence check for every task.

Do not call `database.fetch` with user-controlled queries. Raw database access
is intentionally unfiltered; user-facing reads must go through a gateway
session.

## 5. Define write policies

Every command factory has a default write-policy set. As with reads, define
exactly one policy for every table.

```ts
const writes = hydb.writePolicy(principalSchema);

export const writePolicies = Object.freeze([
  writes.denyAll(users),
  writes.where(projects, ({ change, principal }) => {
    const ownedBefore =
      change.kind === "insert" || change.before.ownerId === principal.userId;
    const ownedAfter =
      change.kind === "delete" || change.after.ownerId === principal.userId;
    return ownedBefore && ownedAfter;
  }),
  writes.through(tasks, projects, {
    from: tasks.projectId,
    to: projects.id,
  }),
]);
```

A `where` write policy receives `{ change, principal, db }` and may be async.
`change` is one of `{ kind: "insert", after }`,
`{ kind: "update", before, after }`, or `{ kind: "delete", before }`.
`db.get(table, key)` can perform an authorization read against the transaction
snapshot.

The project policy checks both sides of an update, preventing an owner from
using an otherwise-authorized update to transfer ownership. Task mutations
inherit authorization from their parent project.

## 6. Define commands once

A command has an input schema, an optional async optimistic method, and only
needs an output schema or server method when it has a meaningful result or
additional backend behavior. The factory supplies the principal type and
default policy to every command in the group.

```ts
import { z } from "zod";

const commands = hyapp.commandFactory({
  principal: principalSchema,
  defaultPolicy: writePolicies,
});

export const createTask = commands.define({
  input: z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().trim().min(1).max(100),
    createdAt: z.date(),
  }),
  async optimistic({ transaction }, input) {
    await transaction.insert(tasks, {
      ...input,
      done: false,
    });
  },
});

export const completeTask = commands.define({
  input: z.object({ taskId: z.string().min(1) }),
  async optimistic({ transaction }, { taskId }) {
    await transaction.update(tasks, [taskId], { done: true });
  },
});
```

The optimistic transaction exposes only `insert`, `update`, and `delete` and
may run in either environment. When `server` is omitted, HyApp applies this
method as the authoritative server transaction. When `output` is omitted, the
command result is `void`. This is the normal form for a mutation whose caller
only needs to know whether it succeeded.

A custom server method receives the authenticated `principal`, the full
transaction, and async `applyOptimistic()`. Calling `applyOptimistic()` lets
custom server execution share the same mutations. It is single-use, and the
server method may instead implement different backend behavior. Define an
output schema only when the caller needs a result from that behavior.

Input is parsed before execution and output is parsed before it crosses the
command boundary. Zod input/output transformations are reflected in the
command's inferred call and result types.

### Explicit authorization overrides

Ordinary mutations use the factory's default policies. An exceptional change
can use `transaction.withAdminPolicy`, but it must prove authorization inside
the same transaction:

```ts
export const transferProject = commands.define({
  input: z.object({
    projectId: z.string().min(1),
    newOwnerId: z.string().min(1),
  }),
  async server({ transaction, principal }, input) {
    await transaction.withAdminPolicy(async ({ db, assert }) => {
      const project = await db.get(projects, [input.projectId]);

      assert(
        project?.ownerId === principal.userId,
        "Only the current project owner can transfer this project",
      );

      await transaction.update(projects, [input.projectId], {
        ownerId: input.newOwnerId,
      });
    });
  },
});
```

The admin scope starts unarmed. It must call `assert` successfully at least
once, and every assertion requires a meaningful error message. A mutation
before a successful assertion, a false assertion, or leaving the callback
without an assertion aborts execution. The override applies only inside the
callback; it is not a way to disable policy checks for an entire command.

Finally, register the commands under stable names:

```ts
export const commandRegistry = hyapp.commandRegistry({
  createTask,
  completeTask,
  transferProject,
});
```

Those keys become the typed command names accepted by gateway clients.

## 7. Compile shared commands for client and server

The unified `commandFactory().define()` source contains both implementations.
Compile it for each target so server code, principal schemas, and write policies
cannot enter the browser dependency graph.

With esbuild:

```ts
// esbuild.client.ts
import { build } from "esbuild";
import { hyappCommandsPlugin } from "@hyos/hyapp/esbuild";

await build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  platform: "browser",
  plugins: [hyappCommandsPlugin({ target: "client" })],
  outfile: "dist/client.js",
});
```

```ts
// esbuild.server.ts
import { build } from "esbuild";
import { hyappCommandsPlugin } from "@hyos/hyapp/esbuild";

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  plugins: [hyappCommandsPlugin({ target: "server" })],
  outfile: "dist/server.js",
});
```

The client transform retains contracts and optimistic methods. The server
transform retains the server factory configuration and both methods. The
client compiler fails closed if a command definition cannot be analyzed
statically; import pruning happens before bundler dependency traversal rather
than relying on tree shaking as a security boundary.

Other build tools can call the target-independent compiler:

```ts
import { compileCommandModule } from "@hyos/hyapp/compiler";

const result = compileCommandModule(source, {
  target: "client",
  filename: id,
});

return result.code;
```

For example, a Vite plugin can invoke this from its `transform(source, id)`
hook for TypeScript and JavaScript application modules.

### Using the base API without a compiler

The compiler lowers unified commands to public runtime constructors. A custom
toolchain can also define its client and server modules explicitly:

```ts
// contracts.ts — safe to import in both builds
import { createCommandContract } from "@hyos/hyapp";
import { z } from "zod";

export const createTaskInput = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  createdAt: z.date(),
});
export const createTaskContract = createCommandContract({
  input: createTaskInput,
});
```

```ts
// commands.client.ts
import { createClientCommandFactory } from "@hyos/hyapp";
import { createTaskContract } from "./contracts.js";

const clientCommands = createClientCommandFactory();

export const createTask = clientCommands.define({
  contract: createTaskContract,
  async optimistic({ transaction }, input) {
    await transaction.insert(tasks, { ...input, done: false });
  },
});
```

```ts
// commands.server.ts
import { createServerCommandFactory } from "@hyos/hyapp";
import { createTaskInput } from "./contracts.js";

const serverCommands = createServerCommandFactory({
  principal: principalSchema,
  defaultPolicy: writePolicies,
});

export const createTask = serverCommands.define({
  input: createTaskInput,
  async optimistic({ transaction }, input) {
    await transaction.insert(tasks, { ...input, done: false });
  },
});
```

This form makes the client/server module boundary explicit while sharing the
Zod schemas that define the wire contract.

## 8. Open storage and create the database

Use the Node storage adapter for a persistent backend:

```ts
import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";

const storage = await openNodeStorage({
  directory: "./data/project-app",
  schema: appSchema,
});

export const database = await hydb.database({
  schema: appSchema,
  storage,
  memory: { maxBytes: 128 * 1024 * 1024 },
});
```

For tests or ephemeral applications:

```ts
import { memoryStorage } from "@hyos/hydb";

const storage = await memoryStorage({ schema: appSchema });
const database = await hydb.database({ schema: appSchema, storage });
```

The database exposes `fetch`, `subscribe`, `transact`, `memoryStats`, and
`close`. Direct database reads have no principal and therefore no read-policy
filter. `transact` is the lower-level policy-aware write API used underneath
HyApp commands.

Close the database during graceful shutdown:

```ts
await database.close();
```

## 9. Create the gateway

The gateway joins the database, command registry, principal schema, and read
policies. A session binds all reads and commands to one validated principal.

```ts
export const gateway = hyapp.gateway({
  database,
  principal: principalSchema,
  registry: commandRegistry,
  readPolicies,
});

const session = gateway.forPrincipal({ userId: "user-123" });

const board = await session.fetch(projectBoardQuery);
const unsubscribe = session.subscribe(projectBoardQuery, (nextBoard) => {
  console.log(nextBoard);
});
await session.dispatch("createTask", {
  id: crypto.randomUUID(),
  projectId: "project-123",
  title: "Document the API",
  createdAt: new Date(),
});

unsubscribe();
```

Direct sessions are useful for trusted backend code and integration tests. They
apply the same read and write policies as remote clients.

## 10. Expose the gateway over HTTP

The Node adapter is a composable handler, not an opinionated server. Its
`principal` callback is where the host application verifies a session, token,
or other credential and returns principal data.

```ts
// server.ts
import { createServer } from "node:http";
import { createNodeGatewayHttpHandler } from "@hyos/hyapp/node";

const handleGateway = createNodeGatewayHttpHandler({
  gateway,
  reads: readRegistry,
  basePath: "/api/hyapp",

  async principal(request) {
    const user = await authenticateRequest(request);
    return { userId: user.id };
  },

  onError(error) {
    console.error(error);
  },
});

const server = createServer(async (request, response) => {
  if (await handleGateway(request, response)) return;

  response.writeHead(404).end();
});

server.listen(3001);
```

The adapter serves one-shot reads, streaming subscriptions, and commands. It
validates registered read names, request sizes, command inputs, principals,
policies, and results. `basePath` defaults to `/api/hyapp`; `maxBodyBytes`
defaults to 64 KiB.

The shared wire codec preserves values JSON alone cannot round-trip faithfully,
including dates, byte arrays, bigints, `undefined`, special numbers, and
objects containing reserved wire keys.

## 11. Create the browser client

Build this module with the client command target. Its imported command registry
then contains contracts and optimistic methods, never server implementations.

```ts
// client.ts
import { hyapp } from "@hyos/hyapp";
import { httpGatewayTransport } from "@hyos/hyapp/http";

export const client = hyapp.gatewayClient({
  registry: commandRegistry,
  transport: httpGatewayTransport({
    reads: readRegistry,
    baseUrl: "/api/hyapp",
    headers: () => ({
      authorization: `Bearer ${readAccessToken()}`,
    }),
    onSubscriptionError(error) {
      console.error("Gateway subscription failed", error);
    },
  }),
});
```

The resulting API is fully typed:

```ts
const board = await client.fetch(projectBoardQuery);

const unsubscribe = client.subscribe(
  projectBoardQuery,
  (nextBoard) => renderBoard(nextBoard),
  (error) => showConnectionError(error),
);

await client.dispatch("createTask", {
  id: crypto.randomUUID(),
  projectId: "project-123",
  title: "Ship it",
  createdAt: new Date(),
});
```

Command names, arguments, and results come from `commandRegistry`; query results
come from the query value. Unknown names and invalid argument shapes fail at
compile time and are validated again at runtime.

For an in-process client in backend tests, pair a client-target registry with a
gateway session:

```ts
import { directGatewayTransport, gatewayClient } from "@hyos/hyapp";

const testClient = gatewayClient({
  registry: clientCommandRegistry,
  transport: directGatewayTransport(
    gateway.forPrincipal({ userId: "user-123" }),
  ),
});
```

### Optimistic coordination

Providing an `optimistic` coordinator lets the client apply a command's
optimistic method to a local replica and reconcile it with the server response:

```ts
const client = hyapp.gatewayClient({
  registry: commandRegistry,
  transport,
  optimistic: {
    async begin(request) {
      const layer = replica.beginLayer(request.invocationId);

      return {
        transaction: layer.transaction,
        applied: () => layer.publish(),
        acknowledged: (response) => layer.commit(response.watermark),
        rejected: (error) => layer.rollback(error),
      };
    },
  },
});
```

The coordinator owns replica-specific layering and rollback. Without one, the
client validates input and sends the command without applying a local update.
If replica data may be missing, its transaction should represent an inapplicable
optimistic mutation as a safe no-op when the command must still reach the
server. Throwing from `begin`, the optimistic method, or `applied` rejects the
client command before transport; throwing is therefore appropriate only when
the command itself should be cancelled.

## 12. Use the Solid helpers

The optional Solid entry point adds reactive query lifecycle and command
pending state without replacing the gateway client API.

```tsx
import { Show } from "solid-js";
import { createCommandDispatcher, createGatewayQuery } from "@hyos/hyapp/solid";

export function ProjectBoard() {
  const board = createGatewayQuery(client, projectBoardQuery);
  const dispatch = createCommandDispatcher(client);

  async function addTask(projectId: string) {
    await dispatch("createTask", {
      id: crypto.randomUUID(),
      projectId,
      title: "New task",
      createdAt: new Date(),
    });
  }

  return (
    <Show when={!board.loading()} fallback={<p>Loading…</p>}>
      <Show when={board.data()}>
        {(projects) => <pre>{JSON.stringify(projects())}</pre>}
      </Show>
      <button
        disabled={dispatch.isPending("createTask")}
        onClick={() => void addTask("project-123")}
      >
        Add task
      </button>
      <button onClick={board.refetch}>Refetch</button>
    </Show>
  );
}
```

`createGatewayQuery` returns reactive `data`, `loading`, and `error` accessors
plus `refetch()`. It performs an initial fetch, owns a live subscription, avoids
fetch/subscription races, and cleans up with the Solid owner. The client and
query arguments may also be accessors, which is useful when login changes the
active client or route parameters change the query.

`createCommandDispatcher` returns the typed `dispatch` function itself.
`dispatch.isPending(commandName)` reads a Solid signal, so a render or effect
that calls it updates automatically. Overlapping executions keep that command
pending until the final call settles.

## Security and lifecycle checklist

- Authenticate the request before creating its principal; do not accept
  principal fields directly from request JSON.
- Define exactly one read and one write policy for every table.
- Route user-controlled reads through `gateway.forPrincipal(...)`, not the raw
  database.
- Compile browser modules with the client command target and treat a compiler
  failure as a build failure.
- Keep server-only imports inside code the command compiler can statically
  identify and remove.
- Use default write policies for normal changes. Reserve `withAdminPolicy` for
  explicit, asserted exceptions.
- Return meaningful authorization messages without secrets or sensitive row
  contents.
- Unsubscribe manual subscriptions and close the database during shutdown.
- Test at least two principals so allowed rows and denied rows are both
  exercised for fetches, subscriptions, and commands.

## Public entry points

| Entry point            | Purpose                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `@hyos/hydb`           | Schema builders, queries, database, memory storage, transactions, and read/write policies |
| `@hyos/hydb/node`      | Persistent Node storage and Node spill adapter                                            |
| `@hyos/hyapp`          | Command factories/contracts, registries, gateway, typed client, and direct transport      |
| `@hyos/hyapp/compiler` | Target-independent shared-command transform                                               |
| `@hyos/hyapp/esbuild`  | Client/server esbuild command plugin                                                      |
| `@hyos/hyapp/http`     | Browser HTTP/streaming gateway transport and `GatewayHttpError`                           |
| `@hyos/hyapp/node`     | Composable Node HTTP gateway handler                                                      |
| `@hyos/hyapp/solid`    | Reactive query state and command dispatcher for Solid                                     |
| `@hyos/hyapp/wire`     | Low-level shared wire encoding helpers for custom transports                              |

The lower-level exports `executeServerCommand`, `executeOptimisticCommand`,
`parseCommandInput`, and `parseCommandResult` are available for adapter and
tooling authors. Most applications should use a gateway session or
`gatewayClient`, which applies the correct parsing and policy boundaries.

See [`docs/commands.md`](./docs/commands.md) for the command-system design and
the complete runnable application in
[`../../examples/project-management`](../../examples/project-management).
