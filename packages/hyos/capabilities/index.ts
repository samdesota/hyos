export * from "./browser.js";
export * from "./agent.js";
export * from "./ui-agent.js";

import { browserCapability } from "./browser.js";
import { agentCapability } from "./agent.js";
import { uiAgentCapability } from "./ui-agent.js";
import { reloadCapability } from "./reload.js";

export const applicationCapabilities = [
  browserCapability,
  agentCapability,
  uiAgentCapability,
  reloadCapability,
] as const;
