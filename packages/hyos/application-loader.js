const path = require("node:path");

function readManifest(manifestPath) {
  const resolved = require.resolve(manifestPath);
  delete require.cache[resolved];
  const loaded = require(resolved);
  const manifest = loaded.applicationManifest ?? loaded.default;
  if (!Array.isArray(manifest.modules)) {
    throw new Error("Application manifest requires a modules array");
  }

  const ids = new Set();
  for (const entry of manifest.modules) {
    if (ids.has(entry.id)) throw new Error(`Duplicate module id: ${entry.id}`);
    if (!["main", "renderer"].includes(entry.host)) {
      throw new Error(`Unsupported host for ${entry.id}: ${entry.host}`);
    }
    ids.add(entry.id);
  }
  return manifest;
}

class MainApplicationLoader {
  constructor({ host, manifestPath, onChanged }) {
    this.host = host;
    this.manifestPath = manifestPath;
    this.modulesDirectory = path.dirname(manifestPath);
    this.onChanged = onChanged;
    this.manifest = readManifest(manifestPath);
    this.entries = [];
  }

  publicManifest() {
    return structuredClone(this.manifest);
  }

  refreshManifest() {
    this.manifest = readManifest(this.manifestPath);
    this.entries = this.manifest.modules.filter(({ host }) => host === "main");
  }

  loadDefinition(entry) {
    const modulePath = path.resolve(this.modulesDirectory, entry.file);
    const moduleDirectory = path.dirname(modulePath);
    for (const cachedPath of Object.keys(require.cache)) {
      if (
        cachedPath === modulePath ||
        cachedPath.startsWith(`${moduleDirectory}${path.sep}`)
      ) {
        delete require.cache[cachedPath];
      }
    }
    const definition = require(modulePath);
    if (!definition?.apply) {
      throw new Error(`${entry.file} does not export a module definition`);
    }
    return definition;
  }

  async start() {
    this.refreshManifest();
    await this.mountFrom(0);
  }

  async mountFrom(index) {
    for (const entry of this.entries.slice(index)) {
      await this.host.mount(this.loadDefinition(entry), entry);
    }
    await this.onChanged?.(this.host.snapshot());
  }

  async reloadFrom(index) {
    await this.host.disposeFrom(index);
    this.refreshManifest();
    await this.mountFrom(index);
  }

  async reloadEntry(id) {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    await this.reloadFrom(index);
    return true;
  }

  async reloadHot() {
    const index = this.entries.findIndex((entry) => entry.reload === "hot");
    if (index >= 0) await this.reloadFrom(index);
  }

  async reloadManifest() {
    await this.host.dispose();
    this.refreshManifest();
    await this.mountFrom(0);
  }
}

module.exports = { MainApplicationLoader, readManifest };
