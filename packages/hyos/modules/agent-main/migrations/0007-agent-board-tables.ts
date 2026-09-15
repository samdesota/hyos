import { ddl, defineMigration } from "@hyos/hydb/node";

import { agentBoards, agentBoardCards, agentBoardMedia } from "../model.js";

/**
 * Adds the legacy board tables. Whiteboard persistence has since moved to the
 * whiteboard.main module's own schema; the tables stay so existing storages
 * keep opening (hydb has no table-removal migration).
 */
export default defineMigration({
  id: "0007-agent-board-tables",
  steps: [
    ddl.addTable(agentBoards),
    ddl.addTable(agentBoardCards),
    ddl.addTable(agentBoardMedia),
  ],
});
