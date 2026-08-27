import { hyapp } from "@hyos/hyapp";
import { hydb, type InferQueryResult } from "@hyos/hydb";
import { z } from "zod";

import { notes, type NoteTag } from "./model.js";

export const principalSchema = z.object({ app: z.literal("hy-notes") });

export const noteTimelineQuery = hydb
  .query(notes)
  .orderBy((note) => [note.createdAt.desc(), note.id.desc()])
  .many();

export type NoteTimeline = InferQueryResult<typeof noteTimelineQuery>;

export const readRegistry = hyapp.gatewayReadRegistry({
  noteTimeline: noteTimelineQuery,
});

const reads = hydb.readPolicy(principalSchema);
export const readPolicies = Object.freeze([reads.allowAll(notes)]);

const writes = hydb.writePolicy(principalSchema);
export const writePolicies = Object.freeze([writes.allowAll(notes)]);

const tagPropertyValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.date(),
]);

const noteTagSchema: z.ZodType<NoteTag> = z.object({
  name: z.string().trim().min(1).max(80),
  properties: z.record(z.string(), tagPropertyValueSchema),
});

const commands = hyapp.commandFactory({
  principal: principalSchema,
  defaultPolicy: writePolicies,
});

export const createNote = commands.define({
  input: z.object({
    id: z.string().min(1),
    title: z.string().trim().max(200).nullable().default(null),
    content: z.string().trim().min(1).max(100_000),
    tags: z.array(noteTagSchema).max(100).default([]),
    createdAt: z.date(),
    updatedAt: z.date(),
  }),
  async optimistic({ transaction }, input) {
    await transaction.insert(notes, input);
  },
});

export const deleteNote = commands.define({
  input: z.object({ id: z.string().min(1) }),
  async optimistic({ transaction }, { id }) {
    await transaction.delete(notes, [id]);
  },
});

export const updateNote = commands.define({
  input: z.object({
    id: z.string().min(1),
    title: z.string().trim().max(200).nullable(),
    content: z.string().trim().min(1).max(100_000),
    updatedAt: z.date(),
  }),
  async optimistic({ transaction }, { id, ...changes }) {
    await transaction.update(notes, [id], changes);
  },
});

export const commandRegistry = hyapp.commandRegistry({
  createNote,
  deleteNote,
  updateNote,
});
