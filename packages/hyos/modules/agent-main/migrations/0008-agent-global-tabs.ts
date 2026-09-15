import { ddl, defineMigration } from "@hyos/hydb/node";

import { agentGlobalTabs } from "../model.js";

/** Adds the agent global tab strip table. */
export default defineMigration({
  id: "0008-agent-global-tabs",
  steps: [ddl.addTable(agentGlobalTabs)],
});
