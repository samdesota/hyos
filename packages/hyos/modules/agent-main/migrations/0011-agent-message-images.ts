import { ddl, defineMigration } from "@hyos/hydb/node";

/** Adds the message-image table (file references for composer attachments). */
export default defineMigration({
  id: "0011-agent-message-images",
  steps: [
    ddl.addTable({
      name: "hyos_agent_message_images",
      columns: [
        {
          name: "id",
          dataType: "id",
          notNull: true,
          primaryKey: true,
        },
        {
          name: "sessionId",
          dataType: "id",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "messageId",
          dataType: "id",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "file",
          dataType: "text",
          notNull: true,
          primaryKey: false,
        },
        {
          name: "mimeType",
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
          name: "hyos_agent_message_images_message_idx",
          unique: false,
          columns: ["messageId", "id"],
        },
      ],
    }),
  ],
});
