# @hyos/ui-agent

Development-only scaffolding for the HyOS visual UI editing agent.

The Vite plugin starts a companion HTTP server, injects its bootstrap script
into the host application, and mounts the server's overlay document in a
full-page iframe.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { reactSourceLocations, uiAgent } from "@hyos/ui-agent/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), reactSourceLocations(), uiAgent()],
});
```

`reactSourceLocations()` only transforms `.jsx` and `.tsx` modules inside the
consuming app's `src` directory. It adds locations such as
`data-source-loc="src/App.tsx:18:5"` to intrinsic DOM elements while leaving
custom React components and all dependency code untouched. For a different
layout, pass `reactSourceLocations({ sourceDir: "client" })`.

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

Run a quick iteration in preview mode before allowing the server to write the
exact replacements:

```ts
const preview = await client.iteration.run.mutate({
  instruction: "Make this button feel less prominent",
  selection: {
    tagName: "button",
    text: "Cancel",
    classNames: ["secondary-action"],
    cssPath: "main > form > button.secondary-action",
  },
  mode: "preview",
});
```

The companion server reads `AI_GATEWAY_API_KEY` from the nearest `.env` file.
It uses `zai/glm-5.3-flash` by default; set `UI_AGENT_MODEL` to test a
different AI Gateway model. The agent can list, search, and read text files
inside the Vite project root. In `apply` mode it only performs exact text
replacements that uniquely match existing files inside that root.

Current routes:

- `GET /health` — readiness check
- `GET /client.js` — host-page iframe bootstrap
- `GET /overlay` — placeholder overlay document
- `/trpc/*` — typed UI-agent API
