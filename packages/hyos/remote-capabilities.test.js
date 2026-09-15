const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MainRemoteCapabilities,
  remoteChannels,
} = require("./remote-capabilities");

test("a module can provide a typed capability added after host startup", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  const remote = new MainRemoteCapabilities({
    definitions: [],
    authorize() {},
    broadcast() {},
  });
  remote.attach(ipcMain);

  const capability = {
    id: "ui-agent",
    version: 1,
    methods: { connection: {} },
    events: {},
  };
  remote.provide(capability, {
    connection: () => ({ serverUrl: "http://127.0.0.1:4317" }),
  });
  remote.configure([]);

  const invoke = handlers.get(remoteChannels.invoke);
  assert.equal(typeof invoke, "function");
  assert.deepEqual(
    await invoke(
      {},
      { capability: "ui-agent", method: "connection", args: [] },
    ),
    { serverUrl: "http://127.0.0.1:4317" },
  );
});
