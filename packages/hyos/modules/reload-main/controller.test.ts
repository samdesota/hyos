import assert from "node:assert/strict";
import test from "node:test";
import { createReloadController, relevantChange } from "./controller.js";

test("source edits only mark pending; explicit reload applies them", async () => {
  let reloads = 0;
  const controller = createReloadController(
    async () => {
      reloads++;
    },
    () => {},
  );
  controller.changed("modules/agent-main/providers/glm.ts");
  assert.equal(controller.state().pending, true);
  assert.equal(reloads, 0);
  await controller.reload();
  assert.equal(reloads, 1);
  assert.deepEqual(controller.state(), {
    pending: false,
    reloading: false,
    error: null,
  });
});

test("generated artifacts and storage do not trigger pending changes", () => {
  for (const path of [
    "renderer/generated/app.js",
    "node_modules/tool/index.js",
    ".data/file.ts",
    ".git/file.ts",
  ])
    assert.equal(relevantChange(path), false);
  assert.equal(relevantChange("modules\\agent-renderer\\AgentApp.tsx"), true);
  assert.equal(relevantChange("application.manifest.ts"), true);
});

test("reloads are single-flight and preserve edits arriving during reload", async () => {
  let finish!: () => void;
  let calls = 0;
  const controller = createReloadController(
    () => {
      calls++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    () => {},
  );
  controller.changed("modules/a.ts");
  const running = controller.reload();
  await controller.reload();
  assert.equal(calls, 1);
  controller.changed("modules/b.ts");
  finish();
  await running;
  assert.equal(controller.state().pending, true);
});

test("failed reload remains retryable", async () => {
  let fail = true;
  const controller = createReloadController(
    async () => {
      if (fail) throw new Error("Could not load module");
    },
    () => {},
  );
  await controller.reload();
  assert.equal(controller.state().error, "Could not load module");
  assert.equal(controller.state().pending, true);
  fail = false;
  await controller.reload();
  assert.equal(controller.state().pending, false);
});
