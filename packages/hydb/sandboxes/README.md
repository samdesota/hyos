# HyDB Interpretability Sandboxes

These throwaway, self-contained HTML sandboxes make HyDB internals inspectable without replacing the real implementation with demo logic.

Run all currently registered sandboxes:

```sh
npm run sandbox --workspace @hyos/hydb
```

Each sandbox owns a `generate.mjs` adapter that creates real HyDB values and passes display stages to `render-sandbox.mjs`. The generated `index.html` needs no server or dependencies and can be opened directly.

To add another sandbox, create `sandboxes/<name>/generate.mjs`, reuse the shared renderer, and register a package script.
