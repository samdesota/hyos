import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the per-folder sidebar state table (manual order + collapse). */
export default defineMigration({
  id: "0010-agent-folder-state",
  steps: [
    ddl.addTable({
      name: "hyos_agent_folder_state",
      columns: [
        {
          name: "folder",
          dataType: "text",
          notNull: true,
          primaryKey: true,
        },
        {
          name: "position",
          dataType: "integer",
          notNull: false,
          primaryKey: false,
        },
        {
          name: "collapsed",
          dataType: "integer",
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
      indexes: [],
    }),
  ],
});
