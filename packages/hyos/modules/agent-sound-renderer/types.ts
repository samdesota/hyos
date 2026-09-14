/**
 * The `agent.sound` provided interface: the enable/disable control the
 * sidebar toggle drives (playback itself lives in the main process).
 * Shared as a type so same-process consumers (agent.renderer's sidebar)
 * stay decoupled from the sound module's implementation.
 */
export interface AgentSound {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
}
