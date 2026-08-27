import assert from "node:assert/strict";
import test from "node:test";

import { uiAgent } from "../src/vite.js";

test("injects the companion server bootstrap script", () => {
  const plugin = uiAgent({ serverUrl: "http://127.0.0.1:4317/" });
  assert.equal(plugin.name, "hyos-ui-agent");
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
        "data-hyos-ui-agent": "",
      },
      injectTo: "body",
    },
  ]);
});
