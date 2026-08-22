# Hyapp command design

Status: core runtime and compiler implemented; client reconciliation pending

## Context

Hydb currently defines commands and executes them directly on `Database`. That
was useful while proving the database transaction model, but commands now need
application concerns that do not belong in a database package:

- a server implementation and a frontend optimistic implementation;
- frontend and backend artifacts compiled from one source definition;
- principal-aware write authorization;
- registration and transport through gateways; and
- reconciliation of optimistic state with the authorized sync stream.

The package seam will therefore be:

- `@hyos/hydb`: schemas, query planning and execution, transactions, policy
  primitives and enforcement, storage interfaces, and storage adapters.
- `@hyos/hyapp`: commands, gateways, client/server compilation, command
  dispatch, optimistic layers, and transport adapters.

The dependency direction is always `hyapp -> hydb`. Policy definitions remain
in hydb because query and transaction implementations must enforce them, while
hyapp selects and supplies the policies for an application operation.

## Goals

1. Define a command once and produce safe frontend and backend artifacts.
2. Make optimistic execution optional, asynchronous, and reusable by the
   authoritative server implementation.
3. Enforce a command's default write-policy set on every database mutation.
4. Permit exceptional writes only after an authorization assertion based on
   reads from the same transaction snapshot.
5. Provide an explicit base interface that works without a bundler plugin.
6. Keep server implementation code and its dependency graph out of frontend
   bundles.

## Non-goals

- Read policy design is unchanged by this proposal.
- HTTP and WebSocket wire formats are not specified here.
- External irreversible effects are not part of the database transaction;
  commands that need them will use a transactional outbox.
- This document does not define conflict resolution between independently
  authored server and optimistic behavior beyond normal optimistic rebase.

## Command factory

A command factory binds the principal schema and default write-policy set for
a family of commands:

```ts
const writes = hydb.writePolicy(principalSchema);

const projectMemberWrites = [
  writes.where(tasks, async ({ change, principal, db }) => {
    const projectId =
      change.kind === "insert"
        ? change.after.projectId
        : change.before.projectId;

    const project = await db.get(projects, [projectId]);
    return project?.ownerId === principal.id;
  }),
];

export const projectCommands = hyapp.commandFactory({
  principal: principalSchema,
  defaultPolicy: projectMemberWrites,
});
```

The factory parses and types the principal for every command it defines. Its
interface has one authoring method:

```ts
interface CommandFactory<Principal> {
  define<InputSchema, OutputSchema>(
    definition: CommandDefinition<Principal, InputSchema, OutputSchema>,
  ): Command<InputSchema, OutputSchema>;
}
```

`define` does not accept a command-level `defaultPolicy` override. Commands
that need another baseline policy use another factory. This makes the policy
shared by a command family visible at its declaration seam and prevents one
command from silently weakening it. Exceptional mutations remain explicit
inside `withAdminPolicy`.

The factory rejects policy values bound to a different principal-schema
instance. A gateway likewise rejects commands whose factories use a different
principal schema from the gateway, even when the schemas happen to infer the
same TypeScript type.

## Unified authoring interface

An application command is authored in one module:

```ts
export const renameTask = projectCommands.define({
  input: z.object({
    taskId: z.string(),
    name: z.string(),
  }),

  output: z.object({
    taskId: z.string(),
  }),

  async optimistic({ transaction }, input) {
    await transaction.update(tasks, [input.taskId], {
      name: input.name,
    });
  },

  async server({ transaction, applyOptimistic, principal }, input) {
    await applyOptimistic();
    return { taskId: input.taskId };
  },
});
```

`input` and `output` are required. `server` is required for a server command.
`optimistic` is optional so a command may deliberately wait for authoritative
state. `principal` in the server context is inferred from the factory's Zod
schema, while command input is inferred independently from its input schema.

Both methods are asynchronous. This gives frontend transactions room to
persist an optimistic layer or resolve local indexes and gives both runtimes
one mutation interface.

The authoritative server context also receives the gateway-validated
`principal`. The optimistic implementation must not make authorization
decisions: its frontend principal state is not authoritative.

## Command registry

A registry gives a family of commands stable transport names while preserving
each command's inferred input and result types:

```ts
export const registry = hyapp.commandRegistry({
  renameTask,
  deleteTask,
});
```

The same registry declaration is used by both targets. In the server artifact
its values are server commands; in the client artifact the command compiler
has replaced them with client commands. The registry's keys and phantom
input/result types remain identical, so no generated TypeScript declaration is
needed to type command calls.

The server gateway accepts only a server-command registry. The gateway client
accepts either command shape at the TypeScript level so the shared source type
survives compilation, but it verifies at runtime that every value was compiled
for the client target. Passing an uncompiled server registry to a browser
client fails immediately.

### Applying the optimistic implementation on the server

The server context receives `applyOptimistic()` rather than reaching through
the command value:

```ts
async server({ transaction, applyOptimistic }, input) {
  await applyOptimistic();
  await transaction.insert(auditEntries, {
    id: crypto.randomUUID(),
    taskId: input.taskId,
  });

  return { taskId: input.taskId };
}
```

`applyOptimistic()`:

- runs the command's optimistic method with the already parsed input;
- binds its mutation sink to the current server transaction;
- observes the policy scope active at the call site;
- may be called at most once for an invocation; and
- throws a descriptive error when the command has no optimistic method.

The single-call rule prevents accidental duplicate mutations. A server method
that needs repetition should extract an ordinary shared function rather than
invoke the optimistic projection more than once.

## Write authorization

Authorization is a property of executing mutations, not a command-level check
that runs before the transaction. Every command inherits its factory's
`defaultPolicy` set, and the default transactor applies it to every staged
insert, update, and delete. Like read policies, write policies are individual
values created by a schema-bound builder and collected into a readonly set.
They are not an object whose keys mirror database tables.

```ts
const writes = hydb.writePolicy(principalSchema);

const projectMemberWrites = [
  writes.where(tasks, async ({ change, principal, db }) => {
    switch (change.kind) {
      case "insert": {
        const project = await db.get(projects, [change.after.projectId]);
        return project?.ownerId === principal.id;
      }

      case "update": {
        if (change.before.projectId !== change.after.projectId) return false;
        const project = await db.get(projects, [change.before.projectId]);
        return project?.ownerId === principal.id;
      }

      case "delete": {
        const project = await db.get(projects, [change.before.projectId]);
        return project?.ownerId === principal.id;
      }
    }
  }),
];
```

A policy function returns a boolean or promise of a boolean. Its `db` reads are
asynchronous and use the same transaction snapshot and overlay as the mutation.
The result must be exactly `true`; authorization reads join the transaction's
read set so the storage commit cannot outlive the snapshot that proved access.

`change` is a discriminated union:

```ts
type WriteChange<Row> =
  | { kind: "insert"; after: Row }
  | { kind: "update"; before: Row; after: Row }
  | { kind: "delete"; before: Row };
```

This keeps one explicit policy per table, matching the read-policy interface,
while still allowing operation-specific rules. The initial builder interface
is:

```ts
interface WritePolicyBuilder<Principal> {
  where<Table>(
    table: Table,
    authorize: (context: {
      change: WriteChange<InferRow<Table>>;
      principal: Principal;
      db: TransactionReader;
    }) => boolean | PromiseLike<boolean>,
  ): WritePolicy<Principal>;

  through<ChildTable, ParentTable>(
    table: ChildTable,
    parent: ParentTable,
    relationship: { from: Column; to: Column },
  ): WritePolicy<Principal>;

  allowAll<Table>(table: Table): WritePolicy<Principal>;
  denyAll<Table>(table: Table): WritePolicy<Principal>;
}
```

`through` authorizes inserts through the `after` relationship, deletes through
the `before` relationship, and updates through both. Requiring both sides on
an update prevents a principal from moving a row out of or into a parent they
cannot modify.

Policy sets are fail-closed, like read-policy sets:

- every schema table must have exactly one policy in the set;
- a missing or duplicate table policy rejects the set;
- a result that is false or cannot be evaluated denies the mutation;
  and
- the read set supporting policy results is validated when the transaction
  commits.

The policy builder is bound to the same principal schema as the gateway. This
prevents accidentally attaching policies written for a different principal
shape.

### Exceptional writes

An exceptional write uses `transaction.withAdminPolicy`. It accepts one
callback and passes `{ db, assert }` into it. The command already receives the
validated `principal`, so `assert` accepts the resulting boolean directly
rather than another function. Despite the name, this is not an unconditional
bypass: the callback must make at least one successful authorization assertion
before it can stage a privileged mutation.

```ts
async server({ transaction, applyOptimistic, principal }, input) {
  await transaction.withAdminPolicy(async ({ db, assert }) => {
    const project = await db.get(projects, [input.projectId]);

    assert(
      project?.ownerId === principal.id,
      "Only the project owner may update tasks outside the default policy",
    );

    await applyOptimistic();
  });

  return { taskId: input.taskId };
}
```

The conceptual interface is:

```ts
type AssertAuthorization = (authorized: boolean, message: string) => void;

interface Transaction {
  withAdminPolicy<Result>(
    execute: (context: {
      db: TransactionReader;
      assert: AssertAuthorization;
    }) => Promise<Result>,
  ): Promise<Result>;
}
```

Every `db` operation is asynchronous and reads from the command transaction's
snapshot. It is provided by `withAdminPolicy` so authorization cannot
accidentally read from a different database or snapshot. The command compares
those results with its validated `principal` and parsed input, then passes the
resulting boolean to `assert`.

An admin scope begins **unarmed**. Calling `assert(true, message)` arms the
scope; `assert(false, message)` throws and leaves it unarmed. Any privileged
insert, update, or delete attempted before the first successful assertion
throws immediately. Returning from the callback without a successful assertion
also throws, even when the callback happened to stage no mutations. This makes
accidental empty authorization impossible to mistake for a valid admin scope.

Every assertion requires a meaningful error message. A missing, empty, or
whitespace-only message is a programmer error and throws regardless of the
authorization result. When authorization is false, `assert` throws an
`AuthorizationError` carrying that message. Messages should explain the rule
that failed without including row contents, credentials, or other sensitive
principal data. The gateway adapter decides whether a message is safe to send
to a client or should be replaced with a generic denial.

Every call to `assert` must receive exactly `true`; multiple calls therefore
combine with AND. Authorization reads participate in the transaction's read
set, so commit must fail if the storage implementation can no longer validate
the snapshot on which an assertion was based.

Only mutations executed within the callback use the admin policy; the default
policy is restored when the callback completes or throws. Nested scopes have
independent assertion requirements and preserve their lexical policy stack.
`applyOptimistic()` observes the scope active at its call site, so it must come
after an assertion when called inside `withAdminPolicy`.

The authorization reads, successful assertions, and mutations they authorize
are retained together in the transaction plan. This avoids a time-of-check /
time-of-use gap and makes the authorization decision available for diagnostics
and audit records.

There is no argument-free `withAdminPolicy()` overload, no two-callback
overload, and no imperative `authorize(): Promise<boolean>` hook on a command.

## Base runtime interface

The compiler is convenience, not a runtime requirement. The base interface
uses explicit constructors:

```ts
const contract = createCommandContract({
  input,
  output,
});

const clientCommands = createClientCommandFactory();

export const clientRenameTask = clientCommands.define({
  contract,
  optimistic,
});

const serverCommands = createServerCommandFactory({
  principal: principalSchema,
  defaultPolicy: projectMemberWrites,
});

export const serverRenameTask = serverCommands.define({
  contract,
  optimistic,
  server,
});
```

The unified `hyapp.commandFactory(...).define(...)` authoring form compiles down
to these constructors. Applications that do not use esbuild can call them
directly or integrate the target-independent compiler with another build
system.

## Compilation

Compilation has two layers:

1. A target-independent TypeScript transform lowers unified command
   definitions into the base constructors.
2. A thin esbuild plugin selects the frontend or backend target and invokes
   that transform from `onLoad`.

Frontend output removes the factory's principal schema and policy set before
dependency traversal. It retains only command contracts and optimistic
implementations:

```ts
const projectCommands = createClientCommandFactory();
projectCommands.define({ input, output, optimistic });
```

Backend output retains the factory configuration and each command's contract,
optimistic implementation, and server implementation:

```ts
const projectCommands = createServerCommandFactory({
  principal: principalSchema,
  defaultPolicy,
});

projectCommands.define({
  contract,
  optimistic,
  server,
});
```

The transform must remove backend-only properties before module dependency
traversal and prune imports used exclusively by removed code. Tree shaking is
not a security mechanism: merely marking server code as unused is
insufficient.

The frontend compiler fails closed when it cannot statically understand a
definition, including computed property names, object spreads that may contain
server fields, mutated definitions, or aliases that escape analysis. It emits
source maps and diagnostics that identify the unsupported syntax.

## Execution order

The authoritative runner executes a command in this order:

1. Validate and parse the principal context and command input.
2. Deduplicate the invocation by its stable invocation ID.
3. Open one database transaction and snapshot.
4. Run `server`; for each mutation, materialize `before` and `after`, evaluate
   its default policy or active admin scope, and stage it only when authorized.
5. Validate the command output while the transaction can still be aborted.
6. Validate the transaction read set underlying policy checks and admin
   assertions.
7. Commit atomically and publish the invocation ID and commit watermark.
8. Return the already validated output.

Handler failure, policy denial, output validation failure, or storage conflict
aborts the entire transaction. Server commands are not automatically rerun
after a conflict because handlers may perform non-repeatable work; retries
must use invocation deduplication and an explicit retry contract.

## Optimistic state and missing local data

The frontend replica is partial. A row missing locally is unknown, not known
to be absent.

The first optimistic transaction interface is therefore write-oriented:
`insert`, `update`, and `delete`. An update or delete targeting a row that is
not local records a latent keyed overlay rather than fabricating a complete
row. If the row later arrives through authorized sync, the overlay is applied.
If it never arrives, no unauthorized base data is inferred or displayed.

Optimistic reads may be added later only with explicit three-state results:
`present`, `absent`, or `unknown`. A normal `undefined` result cannot safely
distinguish absent data from unsynchronized data.

Client-generated stable IDs are preferred for optimistic inserts.

## Reconciliation

Each invocation has a stable client-generated ID. Optimistic changes are kept
as ordered layers above synchronized base state.

- A transport response does not remove an optimistic layer.
- The server publishes the invocation ID and commit watermark with committed
  changes.
- Once the authorized sync stream reaches that watermark, the matching layer
  is removed and later optimistic layers are replayed.
- On rejection, the failed layer is removed immediately and later layers are
  replayed.
- Repeated server delivery of an invocation ID returns the recorded result
  rather than executing the command twice.

Waiting for the sync watermark prevents a successful response from causing a
temporary UI rollback before authoritative rows arrive.

## Gateway role

A gateway registers named server commands and read policies, binds a validated
principal to a session, and is the only client-facing route to command
execution and synchronized reads. The same gateway can be called directly on
the backend or exposed through HTTP/WebSocket adapters.

The gateway does not implement write authorization itself. It supplies the
principal and registered command to the authoritative runner; the transactor
enforces that command's policy set on the resulting mutations.

```ts
const appGateway = hyapp.gateway({
  database,
  principal: principalSchema,
  registry,
  readPolicies,
});
```

## Gateway client

The frontend gateway client takes the compiled registry and a transport
adapter:

```ts
const client = hyapp.gatewayClient({
  registry,
  transport,
});

const renamed = await client.execute("renameTask", {
  taskId: "task-1",
  name: "New name",
});
```

The registry constrains the command name, argument, and result at compile time.
The client also parses command input before sending and validates the transport
result with the command's output schema. `fetch` and `subscribe` preserve the
query's inferred result type.

Every command request includes a client-generated invocation ID. HTTP and
WebSocket adapters implement the `GatewayClientTransport` interface; the
included `directGatewayTransport` connects a client to an in-process,
principal-bound gateway session for tests and backend composition.

An optional `OptimisticCoordinator` owns optimistic layers. For a command with
an optimistic method, the gateway client:

1. begins a layer using the invocation ID;
2. runs and publishes the optimistic transaction;
3. sends the authoritative command;
4. rejects the layer when transport or validation fails; and
5. acknowledges the layer with the server response on success.

Acknowledgment deliberately does not mean removal. The coordinator retains the
layer until the authorized sync stream reaches the response watermark, then
removes it and rebases later layers. The gateway client defines this lifecycle;
the concrete synchronized-store coordinator remains part of the frontend sync
implementation.

## Package migration

The split should happen in dependency order:

1. Establish `@hyos/hyapp` with a one-way dependency on `@hyos/hydb`.
2. Add the policy-aware transaction interface and condition evaluation to
   hydb.
3. Implement the explicit client and server command factories in hyapp.
4. Move gateway ownership and command dispatch to hyapp.
5. Implement the target-independent command transform and esbuild adapter.
6. Migrate applications from `hydb.command`, `hydb.gateway`, and
   `Database.execute`.
7. Remove the legacy command and gateway exports from hydb.

Until steps 2-6 are complete, the existing hydb command implementation remains
available as a compatibility path. It is not re-exported from hyapp because
doing so would accidentally establish the legacy interface as the new package
contract.

## Open questions

- Whether `withAdminPolicy` should be renamed to `withPolicyOverride` to make
  its proof requirement clearer.
- Whether output schemas may contain asynchronous transforms, given that they
  must finish before commit and should not perform external effects.
- How policy proof metadata should be represented in audit events without
  exposing principal-sensitive values.
- Which unsupported authoring patterns the compiler can safely add after the
  initial strict implementation.
