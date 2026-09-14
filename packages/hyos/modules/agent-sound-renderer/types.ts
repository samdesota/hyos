/**
 * The `agent.sound` provided interface: finish-notification playback plus the
 * enable/disable control the sidebar toggle drives. Shared as a type so
 * same-process consumers (agent.renderer's sidebar) stay decoupled from the
 * sound module's implementation.
 */
export interface AgentSound {
  play(): void;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
}
