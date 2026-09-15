import { text } from "@hyos/hydb";
import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the nullable sessions.statusDetail column. */
export default defineMigration({
  id: "0005-agent-sessions-status-detail",
  steps: [ddl.addColumn("hyos_agent_sessions", "statusDetail", text())],
});
