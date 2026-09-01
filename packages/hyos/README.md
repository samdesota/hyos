# Electron browser module prototype

> **Throwaway prototype.** This exists to test the process split described in
> `docs/research/deepseek-spatiotemporal-electron-multiprocess.md`, not to establish
> production architecture.

The prototype demonstrates one logical browser package implemented by four
process-local modules:

- `browser.main` owns tabs, native `WebContentsView`s, presentation bounds, input
  arbitration, and teardown in Electron's main process.
- `browser.remote-client` provides the typed renderer-side browser interface.
- `browser.view` provides the reusable Solid `BrowserView` component.
- `browser.renderer` is an example Solid application that rebuilds the original tabs
  and navigation UI by composing `BrowserView` at a layout-selected location.
- `runtime.js` is a deliberately tiny Cordis-shaped host: modules declare injected
  and provided capabilities, and effects unwind in reverse order when their local
  host is disposed.

Every application module definition lives in `modules/`. The root-level isomorphic
`application.manifest.ts` only places modules in hosts and supplies configuration.
Cross-process interfaces live separately in `capabilities/`:

```ts
export const browserCapability = defineRemoteCapability({
  id: "browser",
  version: 2,
  methods: {
    execute: remoteMethod<readonly [BrowserCommand], BrowserState>(),
    present: remoteMethod<readonly [BrowserPresentation], void>(),
    release: remoteMethod<readonly [PresentationId], void>(),
  },
  events: {
    state: remoteEvent<BrowserState>(),
  },
});
```

Those declarations infer provider implementations, client calls, arguments, return
values, event names, and event payloads. The generic transport also validates the
method and event names at runtime,
routes calls through the sandboxed preload, and withdraws a provider when its owning
module unloads. The preload contains no browser-specific code.

A root manifest placement looks like this:

```ts
{
  "id": "browser.main",
  "file": "./modules/browser-main/index.ts",
  "host": "main",
  "reload": "hot",
  "config": {
    "initialUrl": "https://example.com/"
  }
}
```

Each module is a folder with a thin `index.ts` or `index.tsx` entrypoint. That
entrypoint declares injected and provided capabilities while private files hold the
implementation. The module does not declare its process placement. Main imports the TypeScript manifest
directly. The renderer dynamically imports browser builds of the manifest,
capabilities, and renderer-hosted modules.

## Browser presentation

The Electron shell follows the proven browser-whiteboard stacking model: a base
window owns native browser views, while a transparent child window runs Solid above
them. This allows normal renderer pixels to visibly overlay live browser content.
Native cursor polling transfers input to a browser rectangle unless the pointer is
inside a renderer region marked with `data-browser-overlay`.

Any Solid renderer module can inject `browser.view` and place a tab declaratively:

```tsx
<BrowserView tabId={tab.id} class="browser-surface" />
```

The component measures its own DOM rectangle, coalesces changes, synchronizes the
native view, and releases the presentation when Solid disposes it. It does not own the
tab's lifetime.

## Run

From the repository root:

```sh
npm run demo:hyos
```

Use the tab strip and address, back, forward, and reload controls. Each tab owns a
separate main-process `WebContentsView`; only the active view is attached to the
window. Closing a tab disposes its listeners and web contents.

**Reload modules** unwinds and replaces every module marked `"reload": "hot"` in both
hosts. Editing a referenced file under `modules/` while the app is running reloads
that module and each later dependent definition. Editing the manifest reconciles the
whole application.

Expand **module state** to see the independent host revisions and capability sets.

The embedded page requires network access. Only HTTP and HTTPS navigation is accepted.
