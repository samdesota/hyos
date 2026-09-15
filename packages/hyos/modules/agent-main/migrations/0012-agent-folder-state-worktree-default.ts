import { integer } from "@hyos/hydb";
import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the nullable folder-state.worktreeDefault column. */
export default defineMigration({
  id: "0012-agent-folder-state-worktree-default",
  steps: [
    ddl.addColumn("hyos_agent_folder_state", "worktreeDefault", integer()),
  ],
});
