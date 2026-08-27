import {
  hydb,
  id,
  index,
  json,
  text,
  timestamp,
  type InferInsert,
  type InferRow,
  type InferUpdate,
} from "@hyos/hydb";

export type TagPropertyValue = string | number | boolean | Date;

export type NoteTag = Readonly<{
  name: string;
  properties: Readonly<Record<string, TagPropertyValue>>;
}>;

export const notes = hydb.table(
  "notes",
  {
    id: id().primaryKey(),
    title: text(),
    content: text().notNull(),
    tags: json<readonly NoteTag[]>().notNull().default([]),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
  (columns) => [
    index("notes_created_at_id_idx").on(columns.createdAt, columns.id),
  ],
);

export const notesSchema = hydb.schema({ notes });

export type Note = InferRow<typeof notes>;
export type NewNote = InferInsert<typeof notes>;
export type NoteUpdate = InferUpdate<typeof notes>;
