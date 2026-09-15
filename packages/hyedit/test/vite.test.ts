import assert from "node:assert/strict";
import test from "node:test";

import { hyedit } from "../src/vite.js";

test("injects the companion server bootstrap script", () => {
  const plugin = hyedit({ serverUrl: "http://127.0.0.1:4317/" });
  assert.equal(plugin.name, "hyedit");
  assert.equal(typeof plugin.transformIndexHtml, "function");

  const transform = plugin.transformIndexHtml;
  if (typeof transform !== "function") {
    assert.fail("Expected transformIndexHtml hook");
  }

  const tags = transform.call({} as never, "", {} as never);
  assert.deepEqual(tags, [
    {
      tag: "script",
      attrs: {
        type: "module",
        src: "http://127.0.0.1:4317/client.js",
        "data-hyedit": "",
      },
      injectTo: "body",
    },
  ]);
});
