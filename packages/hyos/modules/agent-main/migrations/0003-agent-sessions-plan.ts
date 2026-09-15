import { text } from "@hyos/hydb";
import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the nullable sessions.plan column. */
export default defineMigration({
  id: "0003-agent-sessions-plan",
  steps: [ddl.addColumn("hyos_agent_sessions", "plan", text())],
});
