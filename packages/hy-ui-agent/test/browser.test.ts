import assert from "node:assert/strict";
import test from "node:test";

import { attachUiAgent } from "../src/browser.js";

test("attaches and disposes the non-Vite browser client", () => {
  const removed: string[] = [];
  let appended: Record<string, unknown> | undefined;
  let dispatched: Event | undefined;
  const script = {
    dataset: {},
    remove: () => removed.push("script"),
  } as unknown as HTMLScriptElement;
  const document = {
    defaultView: {
      dispatchEvent(event: Event) {
        dispatched = event;
        return true;
      },
    },
    createElement(name: string) {
      assert.equal(name, "script");
      return script;
    },
    body: {
      append(value: Record<string, unknown>) {
        appended = value;
      },
    },
    getElementById(id: string) {
      return { remove: () => removed.push(id) };
    },
  } as unknown as Document;

  const dispose = attachUiAgent({
    serverUrl: "http://127.0.0.1:4317/",
    document,
    mode: "embedded",
  });

  assert.equal(appended, script);
  assert.match(
    script.src,
    /^http:\/\/127\.0\.0\.1:4317\/client\.js\?instance=/,
  );
  assert.equal(new URL(script.src).searchParams.get("mode"), "embedded");
  assert.equal(script.type, "module");
  dispose();
  assert.equal(dispatched?.type, "hyos-ui-agent:dispose");
  assert.deepEqual(removed, [
    "script",
    "hyos-ui-agent-overlay",
    "hyos-ui-agent-launcher",
  ]);
});
