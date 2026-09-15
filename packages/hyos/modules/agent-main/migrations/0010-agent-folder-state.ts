import { ddl, defineMigration } from "@hyos/hydb/node";

import { agentFolderState } from "../model.js";

/** Adds the per-folder sidebar state table (manual order + collapse). */
export default defineMigration({
  id: "0010-agent-folder-state",
  steps: [ddl.addTable(agentFolderState)],
});
