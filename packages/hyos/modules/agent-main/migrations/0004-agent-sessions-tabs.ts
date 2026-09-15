import { text } from "@hyos/hydb";
import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the nullable sessions.tabs column (versioned tab-strip JSON). */
export default defineMigration({
  id: "0004-agent-sessions-tabs",
  steps: [ddl.addColumn("hyos_agent_sessions", "tabs", text())],
});
