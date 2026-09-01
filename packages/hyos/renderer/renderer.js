const { ModuleHost, registeredModule } = globalThis.PrototypeModules;
const { RendererRemoteCapabilities } = globalThis.PrototypeRemoteCapabilities;
const generatedBase = new URL("./generated/", window.location.href);
let rendererHost;
let remoteCapabilities;
let entries = [];
let operation = Promise.resolve();

function renderSnapshot() {
  const output = document.querySelector("#renderer-state");
  if (output) output.textContent = JSON.stringify(rendererHost.snapshot());
}

async function importGenerated(filename) {
  const source = new URL(filename, generatedBase);
  source.searchParams.set("revision", `${Date.now()}-${Math.random()}`);
  return await import(source.href);
}

async function loadDefinition(entry) {
  const filename = `${entry.id.replaceAll(".", "-")}.js`;
  await importGenerated(filename);
  return registeredModule(entry.id);
}

async function readEntries() {
  const loadedManifest = await importGenerated("application-manifest.js");
  const capabilities = await importGenerated("capabilities.js");
  const manifest = loadedManifest.applicationManifest ?? loadedManifest.default;
  remoteCapabilities.configure(capabilities.applicationCapabilities);
  entries = manifest.modules.filter(({ host }) => host === "renderer");
}

async function mountFrom(index) {
  for (const entry of entries.slice(index)) {
    await rendererHost.mount(await loadDefinition(entry), entry);
  }
  renderSnapshot();
}

async function reloadFrom(id) {
  const oldIndex = Math.max(
    0,
    rendererHost.mounts.findIndex(({ placement }) => placement.id === id),
  );
  await rendererHost.disposeFrom(oldIndex);
  await readEntries();
  const newIndex = entries.findIndex((entry) => entry.id === id);
  await mountFrom(newIndex < 0 ? 0 : newIndex);
}

function showError(error) {
  const output = document.querySelector("#status");
  if (output) output.textContent = error.message;
  else console.error(error);
}

function enqueue(action) {
  operation = operation.then(action, action).catch(showError);
}

async function start() {
  const capabilities = await importGenerated("capabilities.js");
  remoteCapabilities = new RendererRemoteCapabilities({
    definitions: capabilities.applicationCapabilities,
    transport: window.hyosRemote,
  });
  rendererHost = new ModuleHost("renderer", {
    "dom.root": document,
    "remote.capabilities": remoteCapabilities,
    "application.modules": window.hyosModules,
  });
  window.hyosModules.subscribeSnapshot((snapshot) => {
    const output = document.querySelector("#main-state");
    if (output) output.textContent = JSON.stringify(snapshot);
  });
  window.hyosModules.subscribeReload(({ fromId }) => {
    enqueue(() => reloadFrom(fromId));
  });
  await readEntries();
  await mountFrom(0);
}

start().catch((error) => {
  document.querySelector("#app").textContent = error.message;
});

window.addEventListener("beforeunload", () => {
  rendererHost?.dispose();
  remoteCapabilities?.dispose();
});
