import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the agent global tab strip table. */
export default defineMigration({
  id: "0008-agent-global-tabs",
  steps: [
    ddl.addTable({
      name: "hyos_agent_global_tabs",
      columns: [
        {
          name: "id",
          dataType: "id",
          notNull: true,
          primaryKey: true,
        },
        {
          name: "kind",
          dataType: "text",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "data",
          dataType: "text",
          notNull: false,
          primaryKey: false,
        },
        {
          name: "active",
          dataType: "integer",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "position",
          dataType: "integer",
          notNull: true,
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
          name: "hyos_agent_global_tabs_position_idx",
          unique: true,
          columns: ["position"],
        },
      ],
    }),
  ],
});
