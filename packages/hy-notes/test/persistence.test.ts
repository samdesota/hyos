import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hyapp } from "@hyos/hyapp";
import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";

import {
  commandRegistry,
  noteTimelineQuery,
  principalSchema,
  readPolicies,
} from "../src/application.js";
import { notesSchema } from "../src/model.js";

test("a gateway-created note survives closing and reopening storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hy-notes-"));

  try {
    const firstStorage = await openNodeStorage({
      directory,
      schema: notesSchema,
    });
    const firstDatabase = await hydb.database({
      schema: notesSchema,
      storage: firstStorage,
    });
    const firstGateway = hyapp.gateway({
      database: firstDatabase,
      principal: principalSchema,
      registry: commandRegistry,
      readPolicies,
    });
    const firstSession = firstGateway.forPrincipal({ app: "hy-notes" });
    const capturedAt = new Date("2026-08-24T20:00:00.000Z");

    await firstSession.dispatch("createNote", {
      id: "note-1",
      title: "Persistent thought",
      content: "Stored through **HyApp**.",
      tags: [
        {
          name: "source",
          properties: {
            url: "https://example.com",
            capturedAt,
            confidence: 0.9,
          },
        },
      ],
      createdAt: capturedAt,
      updatedAt: capturedAt,
    });

    await firstDatabase.close();

    const secondStorage = await openNodeStorage({
      directory,
      schema: notesSchema,
    });
    const secondDatabase = await hydb.database({
      schema: notesSchema,
      storage: secondStorage,
    });

    try {
      const secondGateway = hyapp.gateway({
        database: secondDatabase,
        principal: principalSchema,
        registry: commandRegistry,
        readPolicies,
      });
      const notes = await secondGateway
        .forPrincipal({ app: "hy-notes" })
        .fetch(noteTimelineQuery);

      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.title, "Persistent thought");
      assert.equal(notes[0]?.content, "Stored through **HyApp**.");
      assert.deepEqual(notes[0]?.tags, [
        {
          name: "source",
          properties: {
            url: "https://example.com",
            capturedAt,
            confidence: 0.9,
          },
        },
      ]);
    } finally {
      await secondDatabase.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a gateway-deleted note stays deleted after reopening storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hy-notes-delete-"));

  try {
    const firstStorage = await openNodeStorage({
      directory,
      schema: notesSchema,
    });
    const firstDatabase = await hydb.database({
      schema: notesSchema,
      storage: firstStorage,
    });
    const firstGateway = hyapp.gateway({
      database: firstDatabase,
      principal: principalSchema,
      registry: commandRegistry,
      readPolicies,
    });
    const firstSession = firstGateway.forPrincipal({ app: "hy-notes" });
    const capturedAt = new Date("2026-08-25T14:00:00.000Z");

    await firstSession.dispatch("createNote", {
      id: "note-to-delete",
      title: null,
      content: "Temporary thought",
      tags: [],
      createdAt: capturedAt,
      updatedAt: capturedAt,
    });
    await firstSession.dispatch("deleteNote", { id: "note-to-delete" });
    await firstDatabase.close();

    const secondStorage = await openNodeStorage({
      directory,
      schema: notesSchema,
    });
    const secondDatabase = await hydb.database({
      schema: notesSchema,
      storage: secondStorage,
    });

    try {
      const secondGateway = hyapp.gateway({
        database: secondDatabase,
        principal: principalSchema,
        registry: commandRegistry,
        readPolicies,
      });
      const notes = await secondGateway
        .forPrincipal({ app: "hy-notes" })
        .fetch(noteTimelineQuery);

      assert.deepEqual(notes, []);
    } finally {
      await secondDatabase.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a gateway-updated note stays updated after reopening storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hy-notes-update-"));

  try {
    const firstStorage = await openNodeStorage({
      directory,
      schema: notesSchema,
    });
    const firstDatabase = await hydb.database({
      schema: notesSchema,
      storage: firstStorage,
    });
    const firstGateway = hyapp.gateway({
      database: firstDatabase,
      principal: principalSchema,
      registry: commandRegistry,
      readPolicies,
    });
    const firstSession = firstGateway.forPrincipal({ app: "hy-notes" });
    const capturedAt = new Date("2026-08-25T15:00:00.000Z");
    const updatedAt = new Date("2026-08-25T16:00:00.000Z");

    await firstSession.dispatch("createNote", {
      id: "note-to-update",
      title: null,
      content: "Original thought",
      tags: [],
      createdAt: capturedAt,
      updatedAt: capturedAt,
    });
    await firstSession.dispatch("updateNote", {
      id: "note-to-update",
      title: "Revised thought",
      content: "Updated with **Markdown**.",
      updatedAt,
    });
    await firstDatabase.close();

    const secondStorage = await openNodeStorage({
      directory,
      schema: notesSchema,
    });
    const secondDatabase = await hydb.database({
      schema: notesSchema,
      storage: secondStorage,
    });

    try {
      const secondGateway = hyapp.gateway({
        database: secondDatabase,
        principal: principalSchema,
        registry: commandRegistry,
        readPolicies,
      });
      const notes = await secondGateway
        .forPrincipal({ app: "hy-notes" })
        .fetch(noteTimelineQuery);

      assert.equal(notes[0]?.title, "Revised thought");
      assert.equal(notes[0]?.content, "Updated with **Markdown**.");
      assert.deepEqual(notes[0]?.updatedAt, updatedAt);
    } finally {
      await secondDatabase.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
