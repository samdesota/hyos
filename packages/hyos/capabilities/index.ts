export * from "./browser.js";
export * from "./agent.js";
export * from "./ui-agent.js";
export * from "./keybinding.js";

import { browserCapability } from "./browser.js";
import { agentCapability } from "./agent.js";
import { uiAgentCapability } from "./ui-agent.js";
import { keybindingCapability } from "./keybinding.js";
import { reloadCapability } from "./reload.js";

export const applicationCapabilities = [
  browserCapability,
  agentCapability,
  uiAgentCapability,
  keybindingCapability,
  reloadCapability,
] as const;
