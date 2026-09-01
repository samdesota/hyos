// PROTOTYPE: generic asynchronous capability transport for Electron hosts.
(function exposeRemoteCapabilities(globalObject) {
  const remoteChannels = Object.freeze({
    invoke: "prototype:remote:invoke:v1",
    event: "prototype:remote:event:v1",
  });

  function indexDefinitions(definitions = []) {
    return new Map(
      definitions.map((definition) => [
        definition.id,
        {
          ...definition,
          methods: new Set(
            Array.isArray(definition.methods)
              ? definition.methods
              : Object.keys(definition.methods ?? {}),
          ),
          events: new Set(
            Array.isArray(definition.events)
              ? definition.events
              : Object.keys(definition.events ?? {}),
          ),
        },
      ]),
    );
  }

  class MainRemoteCapabilities {
    constructor({ definitions, authorize, broadcast }) {
      this.definitions = indexDefinitions(definitions);
      this.authorize = authorize;
      this.broadcast = broadcast;
      this.providers = new Map();
      this.nextGeneration = 1;
      this.ipcMain = null;
    }

    configure(definitions) {
      this.definitions = indexDefinitions(definitions);
    }

    definition(capability) {
      const id = typeof capability === "string" ? capability : capability?.id;
      const definition = this.definitions.get(id);
      if (!definition) throw new Error(`Unknown remote capability: ${id}`);
      return definition;
    }

    attach(ipcMain) {
      if (this.ipcMain) throw new Error("Remote transport already attached");
      this.ipcMain = ipcMain;
      ipcMain.handle(remoteChannels.invoke, async (event, request) => {
        this.authorize(event);
        const definition = this.definition(request?.capability);
        if (!definition.methods.has(request?.method)) {
          throw new Error(
            `${definition.id} does not expose method ${request?.method}`,
          );
        }
        const provider = this.providers.get(definition.id);
        if (!provider) {
          throw new Error(`Remote capability unavailable: ${definition.id}`);
        }
        const method = provider.implementation[request.method];
        if (typeof method !== "function") {
          throw new Error(
            `Provider ${definition.id} does not implement ${request.method}`,
          );
        }
        return await method(...(request.args ?? []));
      });
    }

    provide(capability, implementation) {
      const definition = this.definition(capability);
      const id = definition.id;
      if (this.providers.has(id)) {
        throw new Error(`Remote capability already provided: ${id}`);
      }
      for (const method of definition.methods) {
        if (typeof implementation[method] !== "function") {
          throw new Error(`Provider ${id} must implement ${method}`);
        }
      }

      const provider = {
        implementation,
        generation: this.nextGeneration++,
      };
      this.providers.set(id, provider);
      this.broadcast({
        type: "availability",
        capability: id,
        available: true,
        generation: provider.generation,
      });

      return () => {
        if (this.providers.get(id) !== provider) return;
        this.providers.delete(id);
        this.broadcast({
          type: "availability",
          capability: id,
          available: false,
          generation: provider.generation,
        });
      };
    }

    publish(capability, event, payload) {
      const definition = this.definition(capability);
      const id = definition.id;
      if (!definition.events.has(event)) {
        throw new Error(`${id} does not expose event ${event}`);
      }
      const provider = this.providers.get(id);
      if (!provider) throw new Error(`Remote capability unavailable: ${id}`);
      this.broadcast({
        type: "event",
        capability: id,
        event,
        generation: provider.generation,
        payload,
      });
    }

    dispose() {
      this.providers.clear();
      if (this.ipcMain) {
        this.ipcMain.removeHandler(remoteChannels.invoke);
        this.ipcMain = null;
      }
    }
  }

  class RendererRemoteCapabilities {
    constructor({ definitions, transport }) {
      this.definitions = indexDefinitions(definitions);
      this.transport = transport;
      this.listeners = new Map();
      this.availability = new Map();
      this.unsubscribe = transport.subscribe((message) =>
        this.receive(message),
      );
    }

    configure(definitions) {
      this.definitions = indexDefinitions(definitions);
    }

    definition(capability) {
      const id = typeof capability === "string" ? capability : capability?.id;
      const definition = this.definitions.get(id);
      if (!definition) throw new Error(`Unknown remote capability: ${id}`);
      return definition;
    }

    receive(message) {
      if (message.type === "availability") {
        this.availability.set(message.capability, message);
        return;
      }
      const key = `${message.capability}:${message.event}`;
      for (const listener of this.listeners.get(key) ?? []) {
        listener(message.payload, {
          generation: message.generation,
        });
      }
    }

    consume(capability) {
      const definition = this.definition(capability);
      const id = definition.id;
      return Object.freeze({
        id,
        version: definition.version,
        call: (method, ...args) => {
          if (!definition.methods.has(method)) {
            return Promise.reject(
              new Error(`${id} does not expose method ${method}`),
            );
          }
          return this.transport.invoke(id, method, args);
        },
        subscribe: (event, listener) => {
          if (!definition.events.has(event)) {
            throw new Error(`${id} does not expose event ${event}`);
          }
          const key = `${id}:${event}`;
          const listeners = this.listeners.get(key) ?? new Set();
          listeners.add(listener);
          this.listeners.set(key, listeners);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.listeners.delete(key);
          };
        },
      });
    }

    dispose() {
      this.unsubscribe();
      this.listeners.clear();
      this.availability.clear();
    }
  }

  const remote = {
    MainRemoteCapabilities,
    RendererRemoteCapabilities,
    remoteChannels,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = remote;
  globalObject.PrototypeRemoteCapabilities = remote;
})(globalThis);
