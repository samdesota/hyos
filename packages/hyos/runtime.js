// PROTOTYPE: a tiny Cordis-shaped lifecycle host, not a Cordis implementation.
(function exposeRuntime(globalObject) {
  const definitions = new Map();

  function defineModule(definition) {
    return Object.freeze(definition);
  }

  function registerModule(definition) {
    definitions.set(definition.id, definition);
    return definition;
  }

  function registeredModule(id) {
    const definition = definitions.get(id);
    if (!definition) throw new Error(`Module file did not register ${id}`);
    return definition;
  }

  class ModuleHost {
    constructor(hostName, initialServices = {}) {
      this.hostName = hostName;
      this.services = new Map(Object.entries(initialServices));
      this.mounts = [];
      this.revision = 0;
    }

    async mount(definition, placement) {
      if (placement.host !== this.hostName) {
        throw new Error(
          `Cannot mount ${placement.id} in ${this.hostName}; the manifest places it in ${placement.host}`,
        );
      }
      if (definition.id !== placement.id) {
        throw new Error(
          `Manifest id ${placement.id} does not match module id ${definition.id}`,
        );
      }

      const missing = definition.inject.filter(
        (key) => !this.services.has(key),
      );
      if (missing.length > 0) {
        throw new Error(
          `${definition.id} is pending on: ${missing.join(", ")}`,
        );
      }

      const disposers = [];
      const context = {
        get: (key) => {
          if (!this.services.has(key))
            throw new Error(`Missing service: ${key}`);
          return this.services.get(key);
        },
        provide: (key, value) => {
          if (this.services.has(key))
            throw new Error(`Service already provided: ${key}`);
          this.services.set(key, value);
          disposers.push(() => {
            if (this.services.get(key) === value) this.services.delete(key);
          });
          return value;
        },
        effect: (install) => {
          const dispose = install();
          if (typeof dispose === "function") disposers.push(dispose);
        },
      };

      try {
        const dispose = await definition.apply(context, placement.config ?? {});
        if (typeof dispose === "function") disposers.push(dispose);
      } catch (error) {
        while (disposers.length > 0) await disposers.pop()();
        throw error;
      }

      const mount = {
        definition,
        placement,
        revision: ++this.revision,
        dispose: async () => {
          while (disposers.length > 0) await disposers.pop()();
        },
      };
      this.mounts.push(mount);
      return mount;
    }

    async disposeFrom(index) {
      while (this.mounts.length > index) await this.mounts.pop().dispose();
    }

    snapshot() {
      return {
        host: this.hostName,
        modules: this.mounts.map(({ definition, placement, revision }) => ({
          id: definition.id,
          file: placement.file,
          revision,
        })),
        capabilities: [...this.services.keys()],
      };
    }

    async dispose() {
      await this.disposeFrom(0);
    }
  }

  const runtime = {
    defineModule,
    ModuleHost,
    registerModule,
    registeredModule,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = runtime;
  globalObject.PrototypeModules = runtime;
})(globalThis);
