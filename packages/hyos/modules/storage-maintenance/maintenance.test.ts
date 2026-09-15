import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import test from "node:test";

import { hydb, id, storageMutation, text } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";

import type { LogEntry, LogSink } from "../log-main/sink.js";
import { scheduleStorageCollection } from "./maintenance.js";

const tasks = hydb.table("maintenance_tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const schema = hydb.schema({ tasks });

function stubSink(): { sink: LogSink; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    sink: {
      path: "stub",
      log(level, source, msg) {
        entries.push({
          ts: new Date().toISOString(),
          level,
          source,
          msg,
        });
      },
    },
  };
}

const waitFor = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("collection backs up the data file before the first collection and logs reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hyos-maintenance-"));
  const { sink, entries } = stubSink();

  try {
    const storage = await openNodeStorage({
      directory,
      schema,
      retention: { mode: "window", keepAtLeast: 1 },
    });
    const initial = await storage.snapshot();
    let head = initial.commit;
    await initial.close();
    for (let index = 0; index < 5; index += 1) {
      const commit = await storage.commit({
        expectedHead: head,
        mutations: [
          index === 0
            ? storageMutation.insert(tasks, {
                id: "task-1",
                title: `Version ${index}`,
              })
            : storageMutation.update(tasks, ["task-1"], {
                id: "task-1",
                title: `Version ${index}`,
              }),
        ],
      });
      head = commit.commit;
    }

    const dispose = scheduleStorageCollection({
      storage,
      directory,
      sink,
      source: "test.module",
      initialDelayMs: 5,
      intervalMs: 3_600_000,
    });

    await waitFor(100);
    dispose();

    const backupStat = await stat(
      path.join(directory, "hydb.data.pre-gc-backup"),
    );
    assert.ok(backupStat.size > 0);
    assert.ok(
      entries.some(
        (entry) =>
          entry.level === "info" &&
          entry.msg.startsWith("storage pre-GC backup created"),
      ),
    );
    const reports = entries.filter((entry) => entry.msg.includes("collected"));
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.source, "test.module");
    await storage.close();

    // A second schedule reuses the existing backup instead of copying again.
    const reopened = await openNodeStorage({ directory, schema });
    const second = stubSink();
    const secondDispose = scheduleStorageCollection({
      storage: reopened,
      directory,
      sink: second.sink,
      source: "test.module",
      initialDelayMs: 5,
      intervalMs: 3_600_000,
    });
    await waitFor(100);
    secondDispose();
    assert.ok(
      second.entries.some((entry) =>
        entry.msg.includes("storage collection in"),
      ),
    );
    assert.ok(
      !second.entries.some((entry) => entry.msg.includes("backup created")),
    );
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the disposer cancels pending collection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hyos-maintenance-dispose-"));
  const { sink, entries } = stubSink();

  try {
    const storage = await openNodeStorage({
      directory,
      schema,
      retention: { mode: "window", keepAtLeast: 1 },
    });
    const dispose = scheduleStorageCollection({
      storage,
      directory,
      sink,
      source: "test.module",
      initialDelayMs: 30_000,
      intervalMs: 3_600_000,
    });
    dispose();
    await waitFor(20);
    assert.equal(entries.length, 0);
    const files = await readdir(directory);
    assert.ok(
      !files.some((file) => file.startsWith("hydb.data.pre-gc-backup")),
    );
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
