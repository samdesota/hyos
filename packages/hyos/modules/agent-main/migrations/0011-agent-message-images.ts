import { ddl, defineMigration } from "@hyos/hydb/node";

import { agentMessageImages } from "../model.js";

/** Adds the message-image table (file references for composer attachments). */
export default defineMigration({
  id: "0011-agent-message-images",
  steps: [ddl.addTable(agentMessageImages)],
});
