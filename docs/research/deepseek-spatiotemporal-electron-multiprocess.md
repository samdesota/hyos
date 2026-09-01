# DeepSeek spatiotemporal plugins and an Electron process boundary

Status: design research, not an implementation specification

## Answer in brief

The referenced work is **DeepSeek Harness**, whose “everything is a plugin” architecture is implemented on Cordis. The paper behind Cordis is Yifan Shi, Wei Zhang, and Tianyi Cui, **“A Programming Paradigm for Spatiotemporal Composability,” arXiv:2608.25512**. Shi and Cui are affiliated with DeepSeek-AI; the paper was submitted on August 26, 2026 and is explicitly linked by the official Harness repository ([paper](https://arxiv.org/abs/2608.25512), [official paper repository](https://github.com/cordiverse/paper), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)).

The paper gives a strong model for **dynamic composition inside one shared context**:

- **Temporal composability:** every effect created by a component carries an inverse owned by its lifecycle, so unloading the component unwinds its effects.
- **Spatial composability:** a component declares the services it needs; the runtime activates, deactivates, or reloads it as providers appear, disappear, or change identity.
- **Context paradigm:** effects and dependencies are mediated through the same context, making ownership and dependency visibility structural rather than conventions spread through component code.

It does **not** provide a complete multi-process component model. Section 6.2 sketches cross-process invocation through a service broker: every process owns a separate Cordis context, a coordinator treats remote services as providers, RPC preserves the interface, and remotely exposable interfaces must be asynchronous. It does not specify distributed activation transactions, paired main/renderer teardown, crash recovery, message ordering, or a shared dependency graph spanning processes ([paper, §§6.1–6.2](https://arxiv.org/pdf/2608.25512)).

For the Electron application, use Cordis locally in each process and make the process boundary an explicit, typed capability seam. A browser feature should be one **logical package** with two separately loaded components:

1. a main-process component that exclusively owns `WebContentsView`, its `WebContents`, navigation policy, native events, and disposal; and
2. a renderer component that owns DOM/UI state and consumes a narrow asynchronous browser capability exposed by a preload bridge.

The main process should coordinate the logical package lifecycle. Do not pretend one JavaScript disposer can unwind effects in another process.

## What the paper actually defines

### Revertible effects: ownership over time

An ordinary side effect becomes revertible when its application yields both the new state and an inverse chosen for the state at which the effect ran. A component can yield several effects over time; the runtime accumulates their inverses and runs them in LIFO order on unload. The paper calls this **local temporal composability**: for one component, its accumulated inverse returns the context to the state from which that component began, subject to the paper's observational equivalence and independence conditions ([paper, §§3.1 and 3.4](https://arxiv.org/pdf/2608.25512)).

In engineering terms, every registration and acquired resource must be created through a lifecycle owner. Timers, listeners, service registrations, child components, views, and handles are effects. A component which allocates them outside the tracked context has stepped outside the guarantee.

### Reactive coeffects: dependencies over space

A component declares a dependency specification over context keys. Whenever providers change, the runtime recomputes a target view that identifies the provider satisfying each key. The component is active only when the specification is satisfied. If a provider disappears or is replaced, dependents drain and unload, then reactivate against the new resolved view. Provider identity matters even when two providers expose equal values ([paper, §§3.2 and 4.2.2](https://arxiv.org/pdf/2608.25512)).

This is more than dependency injection at startup. It is a reactive dependency graph whose lifecycle follows changes in supply.

### Components, fibers, and the shared context

A component combines its dependency declaration with its effectful `apply`. A **fiber** is one live instantiation with lifecycle state, a committed dependency view, and an accumulated disposer. The implementation's lifecycle states include loading, active, unloading, and inactive; a transition completes before a newly observed target is pursued. During unload, dependents drain before the provider's effects are reversed ([paper, §§4.1–4.3 and Algorithm 5 in §5.1.3](https://arxiv.org/pdf/2608.25512)).

The important constraint is that the proofs assume effects are independent in the specified sense and that shared locations are reified as context keys. The runtime cannot prove that a cleanup callback truly reverses its effect; that remains a component-author obligation. Nor can it reverse arbitrary emissions into state it does not exclusively control.

### The system boundary is per resource, not per medium

The paper distinguishes locations the system exclusively controls and can restore from those it cannot. Acquiring a resource can be tracked—opening a file descriptor, allocating memory, or starting a child process can register `close`, `free`, or `kill` as its inverse. Data emitted through the resource is generally outside the boundary and must instead be withheld until commit or compensated at a coarser semantic level. A shared memory region or file becomes “outside” once other processes can mutate it without going through the owning coeffect ([paper, §6.1](https://arxiv.org/pdf/2608.25512)).

That distinction is central for Electron: owning a `WebContentsView` and attaching event listeners are revertible acquisitions; a page's network request, downloaded file, form submission, or message already delivered to another process is not automatically undone by destroying the view.

## How DeepSeek Harness applies the model

The official architecture says the model adapter, tool registry, session log, agent loop, UI-facing services, and supporting policies are all plugins in a shared Cordis context. New behavior mounts beside existing behavior; registrations unwind when the owning plugin unloads. The declarative loader builds a plugin tree from ordered bundle/profile layers and supports live patch reload where the application lifecycle permits it ([Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)).

DeepSeek also demonstrates that “one feature” need not mean “one runtime module.” Its extensions subsystem supports versioned packages with separate **Host** and browser **Client** halves, and the browser has its own Cordis runtime. The halves communicate through typed Remote methods and durable/event delivery rather than sharing objects. The Host owns the package registry and Host-half lifecycle; the Client runner owns page-local Client activation and truth about what that page loaded ([extensions subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/extensions.md), [Client runtime](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/runtime/README.md), [connection layer](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)).

This is useful precedent for package shape, but it is not evidence that Cordis supplies one atomic lifecycle across the wire. The official sources keep Host and Client ownership explicit and exchange identities, results, and events.

The strongest in-repository reference for the wire itself is **Typert**. DeepSeek generates matching Host/consumer invocation descriptors, keeps the description carrier-independent, supports unary and streaming methods, carries cancellation outside business arguments, validates serializable inputs/results, and makes remote mounts fiber-owned. Its gateway is used by WebSocket and in-process carriers, so an Electron IPC carrier could preserve the same separation between business contracts and transport ([Typert remote calls](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/typert.md)). The useful lesson is the shape, not necessarily the code: generate or share one contract, mount a typed consumer service, and let IPC be a replaceable adapter.

## What is and is not covered about multiple processes

### The original paper

The original paper recognizes process boundaries in two places:

- An operating system supplies temporal composability at process granularity, but restarting a process is deliberately presented as a coarse workaround that discards unrelated process-local state ([paper, §1.2.3](https://arxiv.org/pdf/2608.25512)).
- A service broker may link separate Cordis contexts and expose providers through asynchronous RPC ([paper, §6.2](https://arxiv.org/pdf/2608.25512)).

It does not extend the formal context, registry, fiber tree, or recovery accumulator across those contexts. The safe conclusion is: **the paper covers how a component may call a remote provider, not how one component is jointly mounted in two processes**.

### The adjacent Logos preprint

A separate paper posted two days later, **“Logos: An Agent Harness on a Cross-Process Bus,”** explicitly begins from this gap. It states that Cordis's reference implementation carries plugins, lifecycle records, and sessions in one process, then proposes a process-per-plugin, name-routed bus. Its key rules are:

- every reversible effect writes an anchor to a persistent append-only transcript at occurrence time;
- one writer is admitted for each capability/name;
- calls and replies are correlated; supply changes have one observed order;
- a router owns only rebuildable routing state, while session state needed for recovery lives in the transcript;
- a replacement process reconstructs state from the transcript (“cold switching”).

The paper evaluates independent Go, Python, and Node processes over an NDJSON/TCP bus and process-kill scenarios ([Logos, §§4–6](https://arxiv.org/html/2608.28553)).

Logos is relevant design research, but it is **not a DeepSeek-authored Harness release**, and the paper does not link a public implementation repository. It is also more distributed machinery than a single Electron application needs. Its durable-before-visible rule, single-writer capability ownership, stable call identities, and replay principle are the parts worth carrying forward.

## Recommended Electron shape

Electron already fixes the physical boundary. It has one privileged main process, separate renderer processes for windows and web embeds, and a preload layer for exposing narrow IPC-backed APIs to context-isolated renderer code. `WebContentsView` and `WebContents` are main-process APIs; a renderer normally has no direct Node or Electron main-process access ([Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [`WebContentsView`](https://www.electronjs.org/docs/latest/api/web-contents-view), [preload and IPC](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload)).

Use that boundary rather than abstracting it away:

```text
logical browser package
├── shared contract
│   ├── BrowserInstanceId / generation / request ids
│   ├── commands and serializable results
│   └── state/event schemas
├── main component (main Cordis context)
│   ├── provides BrowserHost
│   ├── owns WebContentsView + WebContents
│   ├── enforces navigation/session/security policy
│   └── publishes committed state/events
├── preload adapter
│   └── exposes a narrow async API; no raw ipcRenderer
└── renderer component (renderer Cordis context)
    ├── injects BrowserClient
    ├── owns tabs, controls, layout, and local projections
    └── withdraws UI when the main capability/generation disappears
```

### Illustrative module definitions and configuration

The following is pseudocode, not the exact current Cordis or Electron interface. It
shows the intended module seams and ownership.

```text
modules/
├── application.manifest.json # one placement/configuration manifest
├── browser-contract.ts       # serializable commands, state, events
├── browser-main.ts           # BrowserHost module definition
├── browser-client.ts         # renderer-side IPC adapter definition
└── browser-ui.ts             # renderer UI definition
preload.ts                         # privileged transport adapter, not a module
```

The shared contract contains no Electron types:

```ts
// browser/contract.ts
type BrowserInstanceId = Brand<string, "BrowserInstanceId">;
type BrowserGeneration = Brand<number, "BrowserGeneration">;

type BrowserState = {
  id: BrowserInstanceId;
  generation: BrowserGeneration;
  sequence: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

type BrowserCommand =
  | { type: "create"; initialUrl: string }
  | { type: "navigate"; id: BrowserInstanceId; url: string }
  | { type: "back"; id: BrowserInstanceId }
  | { type: "forward"; id: BrowserInstanceId }
  | { type: "reload"; id: BrowserInstanceId }
  | { type: "close"; id: BrowserInstanceId };

type BrowserResult =
  { type: "created"; state: BrowserState } | { type: "accepted" };

type BrowserEvent =
  | { type: "snapshot"; state: BrowserState }
  | { type: "changed"; state: BrowserState }
  | { type: "closed"; id: BrowserInstanceId; generation: BrowserGeneration };

interface BrowserClient {
  execute(
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserResult>;
  subscribe(listener: (event: BrowserEvent) => void): Disposable;
}

const browserProtocol = defineProtocol({
  name: "browser",
  version: 1,
  commands: BrowserCommandSchema,
  results: BrowserResultSchema,
  events: BrowserEventSchema,
});
```

The main-process definition owns all Electron resources and provides the authoritative
capability:

```ts
// browser/main.ts
const browserMain = defineModule({
  id: "browser.main",
  inject: ["electron.appReady", "electron.windowRegistry", "ipc.host"],
  provide: ["browser.host"],

  apply(ctx, config: BrowserMainConfig) {
    const host = new ElectronBrowserHost({
      windows: ctx.electron.windowRegistry,
      partition: config.partition,
      navigationPolicy: config.navigationPolicy,
    });

    // Registration, IPC handlers, views, listeners, and instances are effects
    // owned by this fiber and unwind when it unloads.
    ctx.provide("browser.host", host);
    ctx.effect(() => ctx.ipc.host.expose(browserProtocol, host));
    ctx.effect(() => host.dispose());
  },
});

class ElectronBrowserHost {
  async execute(command, signal) {
    // Creates/mutates WebContentsView instances in the main process only.
    // Instance registry, generation checks, policy, and event ordering live here.
  }

  dispose() {
    // Stop admission, drain calls, detach listeners, remove views, destroy content.
  }
}
```

The preload is only a transport adapter. It validates the protocol and does not expose
`ipcRenderer` or Electron objects:

```ts
// browser/preload.ts
const client = createElectronIpcClient(browserProtocol, ipcRenderer);

contextBridge.exposeInMainWorld("hyos", {
  browser: {
    execute: (command) => client.execute(command),
    subscribe: (listener) => client.subscribe(listener),
  },
});
```

The renderer definition depends reactively on the bridge capability. If the handshake
or generation disappears, Cordis unloads the dependent browser UI:

```ts
// browser/renderer.ts
const browserRenderer = defineModule({
  id: "browser.renderer",
  inject: ["dom.root", "browser.client"],
  provide: ["browser.ui"],

  apply(ctx, config: BrowserRendererConfig) {
    const model = createBrowserProjection(ctx.browser.client);
    const ui = mountBrowserUI(ctx.dom.root, model, config);

    ctx.provide("browser.ui", ui);
    ctx.effect(() => model.dispose());
    ctx.effect(() => ui.unmount());
  },
});

const browserClientAdapter = defineModule({
  id: "browser.ipc-client",
  inject: ["preload.bridge"],
  provide: ["browser.client"],

  async apply(ctx) {
    const client = await ctx.preload.bridge.connect(browserProtocol);
    ctx.provide("browser.client", client);
    ctx.effect(() => client.disconnect());
  },
});
```

One application manifest relates the independently loaded definitions without
pretending they share a fiber. Placement belongs here rather than being repeated in
each module file:

```json
{
  "modules": [
    {
      "id": "browser.main",
      "file": "./browser-main.js",
      "host": "main",
      "reload": "hot",
      "config": {
        "partition": "persist:hyos-browser",
        "navigationPolicy": "external-content"
      }
    },
    {
      "id": "browser.ipc-client",
      "file": "./browser-client.js",
      "host": "renderer",
      "reload": "hot"
    },
    {
      "id": "browser.renderer",
      "file": "./browser-ui.js",
      "host": "renderer",
      "reload": "hot",
      "config": { "toolbar": true }
    }
  ]
}
```

The manifest is composition metadata, not a distributed lifecycle primitive. Each
loader selects entries for its host, loads their files, and activates and unwinds them
locally. Replacement unloads the changed definition and its later dependents before
loading fresh module code. If both hosts must change atomically, a separate
coordinator must prepare, commit, and compensate each side.

### Main-process component

Define the authoritative service around intent rather than Electron objects. For example: `create`, `attach`, `navigate`, `back`, `forward`, `reload`, `setBounds`, `close`, and a state/event subscription. Do not serialize or proxy `WebContentsView` itself.

Every created browser instance should be an effect owned by the main-process fiber. Its disposer should stop admission, detach every Electron listener, remove the child view from its parent, destroy/close the associated web contents as appropriate, and then delete its registry entry. The main process is the single writer for instance identity and lifecycle.

This follows Electron's ownership: `WebContentsView` is main-only, while each embedded web content has its own renderer. It also keeps untrusted page content away from a privileged plugin context ([Electron `WebContentsView`](https://www.electronjs.org/docs/latest/api/web-contents-view), [process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox), [security guidance](https://www.electronjs.org/docs/latest/tutorial/security)).

### Renderer component and preload adapter

The renderer component should manage only UI and a projection of authoritative browser state. Its `BrowserClient` provider wraps named `ipcRenderer.invoke`/event channels exposed through `contextBridge`; Electron explicitly recommends exposing one safe method per operation rather than the complete `ipcRenderer` surface ([Electron IPC tutorial](https://www.electronjs.org/docs/latest/tutorial/ipc), [`contextBridge`](https://www.electronjs.org/docs/latest/api/context-bridge)).

Treat the bridge connection as a reactive coeffect. The renderer browser UI is active only after a handshake yields a protocol version and main-process generation. A main restart, renderer navigation, or lost bridge withdraws that provider, which unloads dependent UI and discards page-local projections. Reconnection creates a new generation and begins with a fresh snapshot before incremental events.

### Cross-process lifecycle

There are two defensible interpretations of one logical browser plugin:

1. **Recommended initially: paired but independent components.** Main and renderer halves have separate fibers, effects, and failure scopes. A package manifest and shared identity pair them, while the main process remains authoritative. A renderer failure does not destroy the browser instance unless product policy explicitly says it should.
2. **Coordinated package transaction.** If product semantics demand “both halves or neither,” add an explicit coordinator: prepare the main half, activate the renderer half, then commit the package generation. On failure, send compensating disposal to whichever half activated. On removal, stop new calls, drain/unload renderer dependents, then dispose main resources. This is a saga/protocol, not an ordinary Cordis disposer.

Start with the first. It matches Electron's real failure domains and allows the browser surface to remount without destroying live web contents.

### Wire invariants

The cross-process seam should establish these invariants from its first version:

- All APIs are asynchronous, even when the current implementation can answer immediately.
- Every browser instance has a main-minted stable id; every process attachment has a generation.
- Commands have request ids and defined retry/idempotency behavior.
- One main-side owner mutates each browser instance.
- A snapshot is installed before events for that generation are applied.
- Events carry instance id, generation, and monotone sequence; stale generations are ignored.
- Disposal first closes admission, then drains in-flight calls, then removes listeners/resources.
- Durable state is committed before it is announced if recovery after main-process death is a requirement.
- External emissions—navigation side effects, downloads, submitted forms—are explicitly classified as irreversible, withheld, or compensated; “close the view” is not rollback.

These are the process-boundary equivalents of effect ownership and reactive provider identity. They also avoid depending on Electron IPC timing as if it were a shared call stack.

## Decisions to make before implementation

1. **Survival policy:** should a browser instance survive an app-renderer reload? The recommendation above says yes; the main-process instance outlives any one UI attachment.
2. **Main crash recovery:** is rebuilding open tabs after a main-process crash required, or is restart-from-saved-session sufficient? If required, browser lifecycle state needs a durable event log or snapshot; process memory is not enough.
3. **Renderer topology:** does each app window run one renderer Cordis context, and are embedded page renderers treated only as managed content rather than plugin hosts? This is the simplest and safest split.
4. **Package upgrades:** can main and renderer halves temporarily run different versions? Prefer a negotiated protocol version and immutable package generation so a rolling page reload is explicit.
5. **Event fidelity:** which events are authoritative state transitions and which are lossy telemetry? Navigation and instance lifecycle should be ordered/replayable; loading progress and paint metrics can usually be lossy.
6. **Security boundary:** which URLs are trusted, which preload is attached to managed pages, and which browser actions require policy/approval? Keep `contextIsolation` and sandboxing enabled and expose the smallest possible bridge.

## Bottom line

Adopt the DeepSeek/Cordis model for **local plugin ownership and reactive dependency lifecycles**. For Electron, compose one logical feature from two process-local plugins plus a shared wire contract. Make the main-process half the authority because Electron places `WebContentsView` there; make the renderer half a replaceable projection and control surface. Add durable, bus-like coordination only if the product truly requires crash recovery or process-independent plugin residence. The original DeepSeek paper does not give that layer for free.
