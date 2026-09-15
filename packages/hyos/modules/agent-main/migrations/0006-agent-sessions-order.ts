import { integer } from "@hyos/hydb";
import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the nullable sessions.order manual sidebar rank column. */
export default defineMigration({
  id: "0006-agent-sessions-order",
  steps: [ddl.addColumn("hyos_agent_sessions", "order", integer())],
});
