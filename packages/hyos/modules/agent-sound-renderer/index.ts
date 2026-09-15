// Renderer side of the agent finish chime: playback lives in the main
// process (see modules/agent-main/finish-sound.ts), so this module is only a
// thin toggle consumer — it proxies the `agent.sound` capability's enabled
// state for the sidebar's chime button.
import { agentSoundCapability } from "../../capabilities/agent-sound.js";
import type {
  RemoteConsumer,
  RendererRemoteCapabilities,
} from "../../remote-capabilities.js";
import type { AgentSound } from "./types.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;

registerModule(
  defineModule({
    id: "agent.sound.renderer",
    inject: ["remote.capabilities"],
    provide: ["agent.sound"],

    apply(ctx) {
      const remote = ctx.get<RendererRemoteCapabilities>("remote.capabilities");
      const agentSound: RemoteConsumer<typeof agentSoundCapability> =
        remote.consume(agentSoundCapability);

      // Cached mirror of the main-process preference; the capability's
      // `enabled` event keeps it current if it changes elsewhere.
      let enabled = true;
      const listeners = new Set<() => void>();
      const unsubscribe = agentSound.subscribe("enabled", (next) => {
        if (enabled === next) return;
        enabled = next;
        for (const listener of listeners) listener();
      });

      const sound: AgentSound = {
        isEnabled: () => enabled,
        setEnabled(next) {
          enabled = next;
          for (const listener of listeners) listener();
          void agentSound.call("setEnabled", next).catch(() => {
            // The in-memory toggle still applies if the round-trip fails.
          });
        },
      };
      // The AgentSound interface is synchronous; the cache is seeded from
      // the main process without blocking module mount.
      void agentSound.call("isEnabled").then((current) => {
        if (enabled === current) return;
        enabled = current;
        for (const listener of listeners) listener();
      });

      ctx.provide("agent.sound", sound);
      ctx.effect(() => unsubscribe);
    },
  }),
);
