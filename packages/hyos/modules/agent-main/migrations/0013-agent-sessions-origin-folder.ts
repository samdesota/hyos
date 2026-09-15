import { text } from "@hyos/hydb";
import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the nullable session origin folder (worktree session grouping). */
export default defineMigration({
  id: "0013-agent-sessions-origin-folder",
  steps: [ddl.addColumn("hyos_agent_sessions", "originFolder", text())],
});
