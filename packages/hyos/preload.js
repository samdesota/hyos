const { contextBridge, ipcRenderer } = require("electron");

const argument = (name) => {
  const prefix = `--${name}=`;
  const value = process.argv
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error(`Missing preload argument: ${name}`);
  return value;
};

const remoteChannels = {
  invoke: argument("remote-invoke-channel"),
  event: argument("remote-event-channel"),
};

function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

contextBridge.exposeInMainWorld("hyosRemote", {
  invoke: (capability, method, args) =>
    ipcRenderer.invoke(remoteChannels.invoke, { capability, method, args }),
  subscribe: (listener) => subscribe(remoteChannels.event, listener),
});

contextBridge.exposeInMainWorld("hyosModules", {
  reload: () => ipcRenderer.invoke("prototype:modules:reload-request"),
  subscribeReload: (listener) =>
    subscribe("prototype:modules:reload", listener),
  subscribeSnapshot: (listener) =>
    subscribe("prototype:modules:snapshot", listener),
});
