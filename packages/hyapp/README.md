# @hyos/hyapp

`@hyos/hyapp` is the application-model package built on top of `@hyos/hydb`.
It owns commands, gateways, client/server command compilation, and application
authorization orchestration.

`@hyos/hydb` remains the database package. It owns schemas, queries,
transactions, policy primitives and enforcement, storage interfaces, and
storage adapters. The dependency direction is one-way: `hyapp` depends on
`hydb`; `hydb` must not depend on `hyapp`.

The package now provides command factories, shared typed command registries,
client/server command runtimes, a typed gateway client, a target-independent
command compiler, an esbuild adapter, principal-bound gateways, and a shared
HTTP adapter. The legacy `hydb.command` and `hydb.gateway` interfaces remain
during migration. See [the command design](./docs/commands.md) for the interface
and remaining migration sequence.

## HTTP gateway adapter

Applications register stable names for queries shared by the server and
browser:

```ts
const reads = hyapp.gatewayReadRegistry({ board: boardQuery });
```

The Node adapter is a composable request handler. Authentication remains an
application concern; its resolver returns the principal context supplied to
the gateway:

```ts
const handleGateway = createNodeGatewayHttpHandler({
  gateway,
  reads,
  principal: authenticateRequest,
});

createServer(async (request, response) => {
  if (await handleGateway(request, response)) return;
  response.writeHead(404).end();
});
```

The browser adapter implements `GatewayClientTransport`:

```ts
const client = hyapp.gatewayClient({
  registry,
  transport: httpGatewayTransport({ reads }),
});
```

The adapter carries reads, streaming subscriptions, and commands through the
shared `@hyos/hyapp/wire` codec. Dates, undefined values, byte arrays, bigints,
special numbers, and objects containing reserved wire keys round-trip without
JSON data loss.

## SolidJS helpers

The optional `@hyos/hyapp/solid` entry point turns a gateway client into small
reactive query state and a typed command executor:

```tsx
const board = createGatewayQuery(client, boardQuery);
const execute = createGatewayExecutor(client);

<Show when={board.data()}>{(rows) => <Board rows={rows()} />}</Show>;
<button disabled={execute.isPending("createTask")}>Create task</button>;
await execute("createTask", { id, projectId, title });
```

`createGatewayQuery` owns the initial fetch, live subscription, race handling,
cleanup, loading/error state, and explicit refetching. Both its client and query
may be accessors, so changing authenticated gateway context replaces the active
subscription. `createGatewayExecutor` preserves registry-derived command,
input, and result types. Its typed `isPending(command)` method reads reactive
per-command state, so Solid dependents update automatically. Overlapping calls
keep a command pending until its final execution settles. Solid is an optional
peer dependency; non-Solid applications continue to use the base gateway
client directly.
