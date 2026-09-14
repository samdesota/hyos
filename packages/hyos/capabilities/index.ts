export * from "./browser.js";
export * from "./agent.js";
export * from "./whiteboard.js";
export * from "./ui-agent.js";
export * from "./keybinding.js";

import { browserCapability } from "./browser.js";
import { agentCapability } from "./agent.js";
import { whiteboardCapability } from "./whiteboard.js";
import { uiAgentCapability } from "./ui-agent.js";
import { keybindingCapability } from "./keybinding.js";
import { reloadCapability } from "./reload.js";
import { agentSoundCapability } from "./agent-sound.js";

export * from "./agent-sound.js";

export const applicationCapabilities = [
  browserCapability,
  agentCapability,
  agentSoundCapability,
  whiteboardCapability,
  uiAgentCapability,
  keybindingCapability,
  reloadCapability,
] as const;
