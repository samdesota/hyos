import { z } from "zod";

import {
  generatedIgnoreSchema,
  literateBlockSchema,
  literateDiffSchema,
  type LiterateBlock,
  type LiterateDiff,
} from "./domain.js";

export const documentOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set_summary"),
    summary: z.string().min(1).max(1_000),
  }),
  z.object({
    type: z.literal("insert_block"),
    after: z.string().min(1).nullable().optional(),
    block: literateBlockSchema,
  }),
  z.object({
    type: z.literal("replace_block"),
    id: z.string().min(1),
    block: literateBlockSchema,
  }),
  z.object({
    type: z.literal("move_block"),
    id: z.string().min(1),
    after: z.string().min(1).nullable().optional(),
  }),
  z.object({ type: z.literal("remove_block"), id: z.string().min(1) }),
  z.object({
    type: z.literal("set_generated_ignores"),
    entries: z.array(generatedIgnoreSchema).max(100),
  }),
]);

export const documentOperationsSchema = z
  .array(documentOperationSchema)
  .min(1)
  .max(40);

export type DocumentOperation = z.infer<typeof documentOperationSchema>;

function insertionIndex(blocks: LiterateBlock[], after?: string | null) {
  if (after === null) return 0;
  if (after === undefined) return blocks.length;
  const index = blocks.findIndex((block) => block.id === after);
  if (index < 0) throw new Error(`Document block does not exist: ${after}`);
  return index + 1;
}

export function editLiterateDiff(
  current: LiterateDiff | null,
  rawOperations: readonly DocumentOperation[],
): LiterateDiff {
  const operations = documentOperationsSchema.parse(rawOperations);
  let summary = current?.summary ?? "Work in progress";
  let blocks = [...(current?.blocks ?? [])];
  let generatedIgnores = [...(current?.generatedIgnores ?? [])];

  for (const operation of operations) {
    switch (operation.type) {
      case "set_summary":
        summary = operation.summary;
        break;
      case "insert_block": {
        if (blocks.some((block) => block.id === operation.block.id)) {
          throw new Error(
            `Document block already exists: ${operation.block.id}`,
          );
        }
        blocks.splice(
          insertionIndex(blocks, operation.after),
          0,
          operation.block,
        );
        break;
      }
      case "replace_block": {
        const index = blocks.findIndex((block) => block.id === operation.id);
        if (index < 0)
          throw new Error(`Document block does not exist: ${operation.id}`);
        if (operation.block.id !== operation.id) {
          throw new Error("Replacing a block must preserve its stable id");
        }
        blocks[index] = operation.block;
        break;
      }
      case "move_block": {
        if (operation.after === operation.id) {
          throw new Error("A document block cannot be moved after itself");
        }
        const index = blocks.findIndex((block) => block.id === operation.id);
        if (index < 0)
          throw new Error(`Document block does not exist: ${operation.id}`);
        const [block] = blocks.splice(index, 1);
        blocks.splice(insertionIndex(blocks, operation.after), 0, block!);
        break;
      }
      case "remove_block": {
        const index = blocks.findIndex((block) => block.id === operation.id);
        if (index < 0)
          throw new Error(`Document block does not exist: ${operation.id}`);
        blocks.splice(index, 1);
        break;
      }
      case "set_generated_ignores":
        generatedIgnores = [...operation.entries];
        break;
    }
  }

  return literateDiffSchema.parse({ summary, blocks, generatedIgnores });
}
