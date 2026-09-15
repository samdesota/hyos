import { text } from "@hyos/hydb";
import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the nullable sessions.seenStatusDetail column. */
export default defineMigration({
  id: "0009-agent-sessions-seen-status-detail",
  steps: [ddl.addColumn("hyos_agent_sessions", "seenStatusDetail", text())],
});
