# HyOS module principles

Use these rules for changes in this repository, especially `packages/hyos`.

## Module-first features

- Implement every product feature through one or more application modules. Extend an existing module when the feature belongs to its interface; otherwise create a new module.
- Keep runtime, loader, preload, and transport changes generic. They supply mechanisms that modules use rather than containing product behavior.
- When the current module runtime cannot express a requested feature, pause before placing the feature outside a module. Explain the missing runtime primitive and the constraint to the user. The likely next step is to design and implement a generic module-runtime feature, then build the product feature as a module.
- Continue with a non-module implementation only when the user explicitly chooses that tradeoff after the limitation is explained.

## Module shape

- Every application module lives in its own folder under `packages/hyos/modules/`.
- The folder's `index.ts` or `index.tsx` is the module entrypoint. Keep it thin: declare the module ID, injected interfaces, provided interfaces, configuration type, and lifecycle wiring.
- Keep implementation details beside the entrypoint in focused private files. Split by responsibility when a file combines lifecycle, state, transport, presentation, and UI concerns.
- Treat the injected/provided interface as the module's test surface. Hide Electron, IPC, layout tracking, and cleanup mechanics behind that interface.

## Placement and capabilities

- `packages/hyos/application.manifest.ts` is the single source of truth for module placement, load order, reload policy, and application configuration. It lives at the package root and contains no capability definitions.
- Define cross-process contracts in `packages/hyos/capabilities/`. Keep them isomorphic and fully typed: method arguments, method results, event names, and event payloads.
- Same-process modules communicate directly through injected interfaces and may be synchronous. Cross-process interfaces are asynchronous and use the generic remote-capability transport.
- Pass structured-cloneable data across processes. Keep Electron objects and browser-specific IPC details inside their owning process.
- Keep the preload and remote transport generic. Application-specific behavior belongs in modules and capability contracts.

## Lifecycle and reload

- Install listeners, timers, native views, subscriptions, and other side effects through `ctx.effect`, returning a disposer for each resource.
- Make disposal complete and safe during partial startup, hot reload, and window shutdown. Module effects unwind in reverse order.
- Preserve stable module and capability IDs. A change to any private file within a module folder must reload through that folder's manifest entrypoint.
- A `hot` module must restore its provided interfaces and visible state without restarting Electron. Use `restart` only when the process shell cannot be replaced safely.

## Renderer and browser surfaces

- Build renderer UI with SolidJS. Reusable renderer behavior belongs in reusable Solid modules; application composition belongs in a separate renderer module.
- `BrowserView` determines native browser bounds from its rendered DOM element. Callers choose its location through normal layout and never provide fixed window coordinates.
- Native `WebContentsView`s belong to the base window. The transparent Solid renderer window stays above them so renderer content can overlay browser pixels.
- Keep pointer arbitration centralized. Browser regions pass input through; registered renderer overlay regions retain input.

## Adding or changing a module

1. Create or update a module folder and its thin entrypoint.
2. Register placement and configuration in the root application manifest.
3. Add a typed capability under `capabilities/` only when communication crosses a process.
4. Account for every acquired resource in module disposal.
5. Run `npm run check --workspace @hyos/hyos`. Run the Electron smoke test for lifecycle, process, presentation, transport, or reload changes.

The work is complete when type checking passes, every side effect has a disposer, process placement remains manifest-driven, and the relevant runtime behavior has been exercised.
