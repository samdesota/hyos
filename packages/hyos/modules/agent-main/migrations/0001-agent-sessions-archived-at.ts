import { timestamp } from "@hyos/hydb";
import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the nullable sessions.archivedAt column. */
export default defineMigration({
  id: "0001-agent-sessions-archived-at",
  steps: [ddl.addColumn("hyos_agent_sessions", "archivedAt", timestamp())],
});
