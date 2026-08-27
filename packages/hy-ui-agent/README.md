# @hyos/ui-agent

Development-only scaffolding for the HyOS visual UI editing agent.

The Vite plugin starts a companion HTTP server, injects its bootstrap script
into the host application, and mounts the server's overlay document in a
full-page iframe.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { uiAgent } from "@hyos/ui-agent/vite";

export default defineConfig({
  plugins: [uiAgent()],
});
```

The plugin chooses a free companion-server port automatically. The server API
defaults to `http://127.0.0.1:4317` when it is run separately:

```ts
import { createUiAgentServer } from "@hyos/ui-agent/server";

const server = createUiAgentServer({ port: 4317 });
await server.start();
```

Then point the plugin at it:

```ts
uiAgent({ serverUrl: "http://127.0.0.1:4317" });
```

The overlay and agent server communicate through a typed tRPC client:

```ts
import { createUiAgentClient } from "@hyos/ui-agent/client";

const client = createUiAgentClient({
  serverUrl: "http://127.0.0.1:4317",
});

const health = await client.system.health.query();
```

Current routes:

- `GET /health` — readiness check
- `GET /client.js` — host-page iframe bootstrap
- `GET /overlay` — placeholder overlay document
- `/trpc/*` — typed UI-agent API
