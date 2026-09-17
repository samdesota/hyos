import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importFileStorage } from "@hyos/hydb/node";
import { openAgentStorage } from "./storage.js";
import { agentSchema } from "./model.js";
import { scheduleStorageCollection } from "../storage-maintenance/maintenance.js";

test("agent storage refuses an unimported file and opens verified LMDB with collection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hyos-agent-lmdb-"));
  try {
    const original = await openAgentStorage(directory, "file");
    const head = await original.head();
    await original.close();
    await assert.rejects(
      openAgentStorage(directory, "lmdb"),
      /verified file-to-LMDB import/,
    );
    // Startup refuses the switch before creating an empty native environment.
    await assert.rejects(stat(path.join(directory, "lmdb")), /ENOENT/);
    await rm(path.join(directory, "lmdb"), { recursive: true, force: true });
    await importFileStorage({
      sourceFile: path.join(directory, "hydb.data"),
      destinationDirectory: path.join(directory, "lmdb"),
      schema: agentSchema,
    });
    const storage = await openAgentStorage(directory, "lmdb");
    let dispose = () => {};
    try {
      assert.equal(await storage.head(), head);
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const completed = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      dispose = scheduleStorageCollection({
        storage,
        directory,
        backup: "none",
        source: "test",
        initialDelayMs: 1,
        intervalMs: 60000,
        sink: {
          path: "test",
          log(level, _source, msg) {
            if (level === "error") reject(new Error(msg));
            if (msg.includes("storage collection in")) resolve();
          },
        },
      });
      const timer = setTimeout(
        () => reject(new Error("collection timed out")),
        5000,
      );
      try {
        await completed;
      } finally {
        clearTimeout(timer);
      }
      await assert.rejects(
        stat(path.join(directory, "hydb.data.pre-gc-backup")),
        /ENOENT/,
      );
    } finally {
      dispose();
      await storage.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fresh install can initialize LMDB without a legacy file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hyos-agent-fresh-"));
  try {
    const storage = await openAgentStorage(directory, "lmdb");
    await storage.close();
    const reopened = await openAgentStorage(directory, "lmdb");
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
