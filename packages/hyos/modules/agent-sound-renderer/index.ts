// Sound played when an agent session finishes, implemented as a small
// renderer module: it consumes the `agent` capability's `sessions` event,
// watches for a running → finished transition, and plays a bundled audio
// asset through the shared `agent.sound` interface.
import {
  agentCapability,
  type AgentSessionId,
  type AgentSessionStatus,
} from "../../capabilities/agent.js";
import type {
  RemoteConsumer,
  RendererRemoteCapabilities,
} from "../../remote-capabilities.js";
import { FINISH_SOUND_DATA_URI } from "./sound-data.js";

const { defineModule, registerModule } = globalThis.PrototypeModules;

export interface AgentSound {
  play(): void;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
}

function createAgentSound(): AgentSound {
  const audio = new Audio(FINISH_SOUND_DATA_URI);
  audio.volume = 0.5;
  let enabled = true;
  return {
    play() {
      if (!enabled) return;
      audio.currentTime = 0;
      void audio.play().catch(() => {
        // Autoplay restrictions or a mid-play stop: staying silent is fine.
      });
    },
    setEnabled(next) {
      enabled = next;
      if (!next) audio.pause();
    },
    isEnabled: () => enabled,
  };
}

registerModule(
  defineModule({
    id: "agent.sound.renderer",
    inject: ["remote.capabilities"],
    provide: ["agent.sound"],

    apply(ctx) {
      const remote = ctx.get<RendererRemoteCapabilities>("remote.capabilities");
      const agent: RemoteConsumer<typeof agentCapability> =
        remote.consume(agentCapability);
      const sound = createAgentSound();

      // Track the last observed status per session so we only fire on a real
      // running → finished transition, not on the initial snapshot or
      // unrelated updates.
      const lastStatus = new Map<AgentSessionId, AgentSessionStatus>();
      const unsubscribe = agent.subscribe("sessions", ({ sessions }) => {
        const seen = new Set<AgentSessionId>();
        for (const session of sessions) {
          seen.add(session.id);
          const previous = lastStatus.get(session.id);
          lastStatus.set(session.id, session.status);
          if (
            (session.status === "ready" || session.status === "failed") &&
            previous === "running"
          ) {
            sound.play();
          }
        }
        for (const id of [...lastStatus.keys()]) {
          if (!seen.has(id)) lastStatus.delete(id);
        }
      });

      ctx.provide("agent.sound", sound);
      ctx.effect(() => unsubscribe);
    },
  }),
);
