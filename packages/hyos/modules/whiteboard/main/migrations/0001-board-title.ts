import { text } from "@hyos/hydb";
import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the nullable boards.title column (set by the rename bar). */
export default defineMigration({
  id: "0001-whiteboard-board-title",
  steps: [ddl.addColumn("hyos_whiteboard_boards", "title", text())],
});
