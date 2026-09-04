import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { reactSourceLocations } from "../src/react-source-locations.js";

function configure(root: string) {
  const plugin = reactSourceLocations();
  const hook = plugin.configResolved;
  if (typeof hook !== "function") assert.fail("Expected configResolved hook");
  hook.call({} as never, { root } as never);
  return plugin;
}

async function transform(
  plugin: ReturnType<typeof reactSourceLocations>,
  code: string,
  id: string,
) {
  const hook = plugin.transform;
  if (typeof hook !== "function") assert.fail("Expected transform hook");
  return hook.call({} as never, code, id);
}

test("adds source locations to intrinsic elements in the app source directory", async () => {
  const root = join(process.cwd(), "fixture-app");
  const plugin = configure(root);
  const result = await transform(
    plugin,
    "export const App = () => (\n  <main><Button /><button>Save</button></main>\n);",
    join(root, "src", "App.tsx"),
  );

  assert.ok(result && typeof result === "object" && "code" in result);
  if (typeof result.code !== "string") assert.fail("Expected transformed code");
  assert.match(result.code, /<main data-source-loc="src\/App\.tsx:2:3">/);
  assert.match(result.code, /<button data-source-loc="src\/App\.tsx:2:19">/);
  assert.doesNotMatch(result.code, /<Button data-source-loc/);
});

test("does not transform files outside the configured source directory", async () => {
  const root = join(process.cwd(), "fixture-app");
  const plugin = configure(root);
  const code = "export const Button = () => <button>Save</button>;";

  assert.equal(
    await transform(
      plugin,
      code,
      join(root, "node_modules", "kit", "Button.tsx"),
    ),
    null,
  );
  assert.equal(
    await transform(plugin, code, join(root, "shared", "Button.tsx")),
    null,
  );
});

test("preserves an existing source location attribute", async () => {
  const root = join(process.cwd(), "fixture-app");
  const plugin = configure(root);
  const result = await transform(
    plugin,
    'export const App = () => <div data-source-loc="manual">Hi</div>;',
    join(root, "src", "App.jsx"),
  );

  assert.equal(result, null);
});

test("supports a custom source directory without widening the boundary", async () => {
  const root = join(process.cwd(), "fixture-app");
  const plugin = reactSourceLocations({ sourceDir: "client" });
  const hook = plugin.configResolved;
  if (typeof hook !== "function") assert.fail("Expected configResolved hook");
  hook.call({} as never, { root } as never);
  const code = "export const App = () => <main>Hi</main>;";

  assert.equal(
    await transform(plugin, code, join(root, "src", "App.tsx")),
    null,
  );
  const result = await transform(plugin, code, join(root, "client", "App.tsx"));
  assert.ok(result && typeof result === "object" && "code" in result);
});

test("rejects a source directory outside the Vite app root", () => {
  const root = join(process.cwd(), "fixture-app");
  const plugin = reactSourceLocations({ sourceDir: "../shared" });
  const hook = plugin.configResolved;
  if (typeof hook !== "function") assert.fail("Expected configResolved hook");

  assert.throws(
    () => hook.call({} as never, { root } as never),
    /sourceDir must be inside the Vite app root/,
  );
});
