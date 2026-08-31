import { z } from "zod";

export const proseBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("prose"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(40_000),
});

export const diagramBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("diagram"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(40_000),
});

export const applyPatchBlockSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("apply_patch"),
  repository: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(20_000),
  file: z.string().min(1).max(1_000).optional(),
  patch: z.string().min(1).max(200_000),
  fullFile: z.string().max(500_000).optional(),
});

export const literateBlockSchema = z.discriminatedUnion("kind", [
  proseBlockSchema,
  diagramBlockSchema,
  applyPatchBlockSchema,
]);

export const generatedIgnoreSchema = z.object({
  repository: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000),
  reason: z.string().min(1).max(1_000),
});

export const workspaceRepositorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  root: z.string().trim().min(1).max(4_000),
});

export const literateDiffSchema = z
  .object({
    summary: z.string().min(1).max(1_000),
    blocks: z.array(literateBlockSchema).max(80),
    generatedIgnores: z.array(generatedIgnoreSchema).max(100).default([]),
  })
  .superRefine((document, context) => {
    const ids = document.blocks.map((block) => block.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Literate diff block ids must be unique",
        path: ["blocks"],
      });
    }
  });

export type LiterateBlock = z.infer<typeof literateBlockSchema>;
export type LiterateDiff = z.infer<typeof literateDiffSchema>;
export type GeneratedIgnore = LiterateDiff["generatedIgnores"][number];
export type SessionStatus =
  "draft" | "running" | "ready" | "committed" | "failed";
export type MessageRole = "user" | "agent" | "system";

export type WorkspaceRepository = z.infer<typeof workspaceRepositorySchema>;

export interface AgentMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
}

export interface LiterateRevision extends LiterateDiff {
  id: string;
  number: number;
  createdAt: Date;
}

export interface SessionSnapshot {
  id: string;
  title: string;
  status: SessionStatus;
  messages: AgentMessage[];
  revision: LiterateRevision | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionListItem = Pick<
  SessionSnapshot,
  "id" | "title" | "status" | "createdAt" | "updatedAt"
>;
