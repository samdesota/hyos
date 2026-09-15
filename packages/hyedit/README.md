# @hyos/hyedit

Development-only scaffolding for the HyOS visual UI editing agent.

The Vite plugin starts a companion HTTP server, injects its bootstrap script
into the host application, and mounts the server's overlay document in a
full-page iframe.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { reactSourceLocations, hyedit } from "@hyos/hyedit/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), reactSourceLocations(), hyedit()],
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
import { createHyeditServer } from "@hyos/hyedit/server";

const server = createHyeditServer({ port: 4317 });
await server.start();
```

For browser hosts that do not use Vite, attach the client explicitly and
dispose it with the host's lifecycle:

```ts
import { attachHyedit } from "@hyos/hyedit/browser";

const detach = attachHyedit({ serverUrl: "http://127.0.0.1:4317" });
// Later: detach();
```

Electron hosts can use `mode: "embedded"` to render the overlay in an isolated
Shadow DOM instead of a cross-origin iframe. This avoids opaque iframe
compositing while keeping the overlay stylesheet separate from the host page.

Then point the plugin at it:

```ts
hyedit({ serverUrl: "http://127.0.0.1:4317" });
```

The overlay and agent server communicate through a typed tRPC client:

```ts
import { createHyeditClient } from "@hyos/hyedit/client";

const client = createHyeditClient({
  serverUrl: "http://127.0.0.1:4317",
});

const health = await client.system.health.query();
```

Run a quick iteration in preview mode before allowing the server to write the
exact replacements:

```ts
const preview = await client.iteration.run.mutate({
  requestId: crypto.randomUUID(),
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
It uses `zai/glm-5.3-flash` by default; set `HYEDIT_MODEL` to test a
different AI Gateway model. The agent can list, search, and read text files
inside the Vite project root. In `apply` mode it only performs exact text
replacements that uniquely match existing files inside that root.
Set `HYEDIT_REASONING` to `none`, `minimal`, `low`, `medium`, `high`, or
`xhigh` to control reasoning-capable models.
Set `HYEDIT_PROVIDER_ORDER` to a comma-separated provider preference such as
`parasail,morph,baseten`.

In development, frontend console messages, browser errors, backend requests,
agent steps, tool calls, durations, and failures are written to
`.hyedit/development.sqlite`. Events share the iteration `requestId`, so a
single edit can be traced across the browser, server, and agent. Disable this
with `hyedit({ server: { telemetry: { enabled: false } } })`, or set a custom
`databasePath` in the same option. The store retains the newest 50,000 events.

## Region iteration UI

With the dev server running, press `Hyper + E` or click the `Quick edit`
launcher to enter region selection mode. Drag around part of the page, describe
the change, and submit.
The edit panel reconnects to an in-progress iteration after a Vite page reload.
After a change is applied, it stays open until you undo the file changes or
dismiss the result. You can also submit follow-up instructions against the same
selected region; follow-ups continue the prior agent conversation, including
its tool calls and applied or undone changes.
The host-page script collects visible DOM elements intersecting the rectangle,
including any `data-source-loc` values, and captures a cropped screenshot. The
instruction, element context, relevant source files, and screenshot are sent to
the configured AI Gateway model; a successful response is applied immediately.

The iframe owns the selection and prompt UI, while the injected host script
owns DOM inspection and screenshot capture. This keeps cross-origin iframe
access out of the design and prevents the overlay itself from appearing in the
captured image.

Current routes:

- `GET /health` — readiness check
- `GET /client.js` — host-page iframe bootstrap
- `GET /html2canvas.js` — local screenshot renderer used by the host script
- `GET /overlay` — region-selection and instruction UI
- `/trpc/*` — typed hyedit API
