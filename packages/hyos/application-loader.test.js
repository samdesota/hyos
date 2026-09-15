const assert = require("node:assert/strict");
const test = require("node:test");

const { ChangedFileBatch } = require("./application-loader");

test("a reload debounce preserves every changed file with capabilities first", () => {
  const batch = new ChangedFileBatch();
  batch.add("modules/agent-main/host.ts");
  batch.add("capabilities/agent.ts");
  batch.add("modules/agent-renderer/DiffViewer.tsx");

  assert.deepEqual(batch.drain(), [
    "capabilities/agent.ts",
    "modules/agent-main/host.ts",
    "modules/agent-renderer/DiffViewer.tsx",
  ]);
  assert.deepEqual(batch.drain(), []);
});
