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
command compiler, an esbuild adapter, and principal-bound gateways. The legacy
`hydb.command` and `hydb.gateway` interfaces remain during migration. See [the
command design](./docs/commands.md) for the interface and remaining migration
sequence.
