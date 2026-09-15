import { ddl, defineMigration } from "@hyos/hydb/node";

/**
 * Adds the legacy board tables. Whiteboard persistence has since moved to the
 * whiteboard.main module's own schema; the tables stay so existing storages
 * keep opening (hydb has no table-removal migration).
 */
export default defineMigration({
  id: "0007-agent-board-tables",
  steps: [
    ddl.addTable({
      name: "hyos_agent_boards",
      columns: [
        {
          name: "id",
          dataType: "id",
          notNull: true,
          primaryKey: true,
        },
        {
          name: "createdAt",
          dataType: "timestamp",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "updatedAt",
          dataType: "timestamp",
          notNull: true,
          primaryKey: false,
        },
      ],
      indexes: [
        {
          name: "hyos_agent_boards_updated_idx",
          unique: false,
          columns: ["updatedAt"],
        },
      ],
    }),
    ddl.addTable({
      name: "hyos_agent_board_cards",
      columns: [
        {
          name: "id",
          dataType: "id",
          notNull: true,
          primaryKey: true,
        },
        {
          name: "boardId",
          dataType: "id",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "x",
          dataType: "number",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "y",
          dataType: "number",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "markdown",
          dataType: "text",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "mediaId",
          dataType: "id",
          notNull: false,
          primaryKey: false,
        },
        {
          name: "createdAt",
          dataType: "timestamp",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "updatedAt",
          dataType: "timestamp",
          notNull: true,
          primaryKey: false,
        },
      ],
      indexes: [
        {
          name: "hyos_agent_board_cards_board_idx",
          unique: false,
          columns: ["boardId", "id"],
        },
      ],
    }),
    ddl.addTable({
      name: "hyos_agent_board_media",
      columns: [
        {
          name: "id",
          dataType: "id",
          notNull: true,
          primaryKey: true,
        },
        {
          name: "boardId",
          dataType: "id",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "data",
          dataType: "text",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "createdAt",
          dataType: "timestamp",
          notNull: true,
          primaryKey: false,
        },
      ],
      indexes: [
        {
          name: "hyos_agent_board_media_board_idx",
          unique: false,
          columns: ["boardId", "id"],
        },
      ],
    }),
  ],
});
