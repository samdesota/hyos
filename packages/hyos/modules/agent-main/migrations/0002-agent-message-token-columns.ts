import { integer } from "@hyos/hydb";
import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the nullable per-message token accounting columns. */
export default defineMigration({
  id: "0002-agent-message-token-columns",
  steps: [
    ddl.addColumn("hyos_agent_messages", "promptTokens", integer()),
    ddl.addColumn("hyos_agent_messages", "completionTokens", integer()),
    ddl.addColumn("hyos_agent_messages", "contextWindow", integer()),
  ],
});
