import { EventEmitter, on } from "node:events";

import type { AgentActivity } from "./agent-types.js";

const terminalPhases = new Set<AgentActivity["phase"]>(["complete", "error"]);

export class IterationActivityBus {
  readonly #emitter = new EventEmitter();
  readonly #history = new Map<string, AgentActivity[]>();

  publish(requestId: string, activity: Omit<AgentActivity, "timestamp">): void {
    const event = { ...activity, timestamp: Date.now() };
    const events = this.#history.get(requestId) ?? [];
    events.push(event);
    this.#history.set(requestId, events.slice(-100));
    this.#emitter.emit(requestId, event);
    if (terminalPhases.has(event.phase)) {
      setTimeout(() => this.#history.delete(requestId), 60_000).unref();
    }
  }

  async *subscribe(requestId: string, signal: AbortSignal) {
    const stream = on(this.#emitter, requestId, { signal });
    for (const event of this.#history.get(requestId) ?? []) {
      yield event;
      if (terminalPhases.has(event.phase)) return;
    }
    try {
      for await (const [event] of stream) {
        const activity = event as AgentActivity;
        yield activity;
        if (terminalPhases.has(activity.phase)) return;
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
