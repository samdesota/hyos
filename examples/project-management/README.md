# HyApp project management example

A complete SolidJS application backed by a Node `hyapp` gateway and HyDB's
persistent Node storage adapter.

The shared application model in `src/data.ts` defines the schema, named reads,
read and write policies, isomorphic commands, and typed command registry. The
browser build compiles those commands to client-safe contracts and optimistic
handlers. HyApp's HTTP adapter carries named reads, streaming subscriptions, and
commands over its shared wire codec. The server retains the authoritative
handlers and binds every request to a principal before it reaches the gateway.

## Run in development

From the repository root:

```sh
npm run demo:project-management
```

The frontend runs at `http://127.0.0.1:5173` and proxies gateway traffic to the
Node backend at `http://127.0.0.1:3001`. Data is persisted under
`examples/project-management/.data`.

The routed login screen is deliberately simple demo authentication. It stores
the selected seeded identity for the browser session and sends its ID to the
backend; the backend validates that identity and supplies the resulting
principal context to the gateway. Authorization is not performed in the UI:

- users may read the team directory;
- users may read and mutate only projects they own;
- task access is inherited through the owning project;
- every query, live subscription, and command passes through the gateway.

## Production build

```sh
npm run build --workspace @hyos/hydb-project-management-example
npm run start --workspace @hyos/hydb-project-management-example
```

The production server serves both the built frontend and the gateway routes.

## End-to-end tests

```sh
npm run test:e2e --workspace @hyos/hydb-project-management-example
```

Playwright starts an isolated persistent backend and the real Vite browser
application. The tests cover policy-filtered synchronization, durable commands,
live updates, reload persistence, login/logout, and principal switching.
