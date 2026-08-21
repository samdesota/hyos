import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HistoryUnavailableError,
  hydb,
  id,
  memoryStorage,
  storageMutation,
  text,
} from "../src/index.js";
import { openNodeStorage } from "../src/node/index.js";

const tasks = hydb.table("retention_tasks", {
  id: id().primaryKey(),
  title: text().notNull(),
});
const schema = hydb.schema({ tasks });

test("node storage persists its retention policy and rejects accidental changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-retention-policy-"));
  const retention = {
    mode: "window" as const,
    keepAtLeast: 3,
    keepYoungerThanMs: 60_000,
  };

  try {
    const storage = await openNodeStorage({ directory, schema, retention });
    await storage.close();

    const reopened = await openNodeStorage({ directory, schema });
    await reopened.close();

    await assert.rejects(
      openNodeStorage({
        directory,
        schema,
        retention: { mode: "forever" },
      }),
      /retention policy does not match/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid retention configuration is rejected before storage is created", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-retention-invalid-"));

  try {
    await assert.rejects(
      openNodeStorage({
        directory,
        schema,
        retention: { mode: "window", keepAtLeast: 0 },
      }),
      /keepAtLeast must be a positive integer/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory storage exposes retain-forever collection semantics", async () => {
  const storage = await memoryStorage({ schema });
  const initial = await storage.snapshot();
  const commit = await storage.commit({
    expectedHead: initial.commit,
    mutations: [
      storageMutation.insert(tasks, { id: "task-1", title: "Retained" }),
    ],
  });
  await initial.close();

  await storage.retain({ name: "release/v1", commit: commit.commit });
  assert.deepEqual(await storage.collectGarbage(), {
    commitsCollected: 0,
    recordsCopied: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesReclaimed: 0,
  });
  await storage.releaseRetention("release/v1");
  const historical = await storage.snapshot({ commit: commit.commit });
  assert.equal((await historical.get(tasks, ["task-1"]))?.title, "Retained");
  await historical.close();
  await storage.close();
});

test("named retains preserve historical indexes across collection and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-retention-gc-"));

  try {
    const storage = await openNodeStorage({
      directory,
      schema,
      retention: { mode: "window", keepAtLeast: 1 },
      maxEntries: 4,
    });
    const initial = await storage.snapshot();
    let head = initial.commit;
    await initial.close();
    const commits = [];
    for (let index = 0; index < 8; index += 1) {
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
      commits.push(commit);
      head = commit.commit;
    }

    await storage.retain({ name: "release/v1", commit: commits[1]!.commit });
    const report = await storage.collectGarbage();
    assert.ok(report.commitsCollected >= 5);
    assert.ok(report.bytesAfter < report.bytesBefore);

    await assert.rejects(
      storage.snapshot({ commit: commits[3]!.commit }),
      HistoryUnavailableError,
    );
    await storage.close();

    const reopened = await openNodeStorage({ directory, schema });
    const retained = await reopened.snapshot({ commit: commits[1]!.commit });
    assert.equal((await retained.get(tasks, ["task-1"]))?.title, "Version 1");
    await retained.close();
    assert.equal(await reopened.head(), commits[7]!.commit);

    await reopened.releaseRetention("release/v1");
    await reopened.collectGarbage();
    await assert.rejects(
      reopened.snapshot({ commit: commits[1]!.commit }),
      HistoryUnavailableError,
    );
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an open snapshot pins its generation and commit until close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-retention-pin-"));

  try {
    const storage = await openNodeStorage({
      directory,
      schema,
      retention: { mode: "window", keepAtLeast: 1 },
    });
    const initial = await storage.snapshot();
    const first = await storage.commit({
      expectedHead: initial.commit,
      mutations: [
        storageMutation.insert(tasks, { id: "task-1", title: "Pinned" }),
      ],
    });
    await initial.close();
    const second = await storage.commit({
      expectedHead: first.commit,
      mutations: [
        storageMutation.update(tasks, ["task-1"], {
          id: "task-1",
          title: "Second",
        }),
      ],
    });
    await storage.commit({
      expectedHead: second.commit,
      mutations: [
        storageMutation.update(tasks, ["task-1"], {
          id: "task-1",
          title: "Head",
        }),
      ],
    });

    const pinnedPromise = storage.snapshot({ commit: first.commit });
    const collection = storage.collectGarbage();
    const pinned = await pinnedPromise;
    await collection;
    assert.equal((await pinned.get(tasks, ["task-1"]))?.title, "Pinned");
    const copiedPin = await storage.snapshot({ commit: first.commit });
    assert.equal((await copiedPin.get(tasks, ["task-1"]))?.title, "Pinned");
    await copiedPin.close();
    await pinned.close();

    await storage.collectGarbage();
    await assert.rejects(
      storage.snapshot({ commit: first.commit }),
      HistoryUnavailableError,
    );
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("active change streams pin replay history and expired cursors fail explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-retention-stream-"));

  try {
    const storage = await openNodeStorage({
      directory,
      schema,
      retention: { mode: "window", keepAtLeast: 1 },
    });
    const initial = await storage.snapshot();
    let head = initial.commit;
    await initial.close();
    const commits = [];
    for (let index = 1; index <= 5; index += 1) {
      const commit = await storage.commit({
        expectedHead: head,
        mutations: [
          index === 1
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
      commits.push(commit);
      head = commit.commit;
    }

    const controller = new AbortController();
    const active = storage
      .changes({ after: 0, signal: controller.signal })
      [Symbol.asyncIterator]();
    assert.equal((await active.next()).value?.commit, commits[0]!.commit);
    await storage.collectGarbage();
    for (const commit of commits.slice(1)) {
      assert.equal((await active.next()).value?.commit, commit.commit);
    }
    controller.abort();
    await active.return?.();

    await storage.collectGarbage();
    const expired = storage.changes({ after: 0 })[Symbol.asyncIterator]();
    await assert.rejects(expired.next(), HistoryUnavailableError);

    const suffixController = new AbortController();
    const suffix = storage
      .changes({ after: 4, signal: suffixController.signal })
      [Symbol.asyncIterator]();
    assert.equal((await suffix.next()).value?.commit, commits[4]!.commit);
    suffixController.abort();
    await suffix.return?.();
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collection preserves branch heads and branch creation commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-retention-branches-"));

  try {
    const storage = await openNodeStorage({
      directory,
      schema,
      retention: { mode: "window", keepAtLeast: 1 },
    });
    const initial = await storage.snapshot();
    const base = await storage.commit({
      expectedHead: initial.commit,
      mutations: [
        storageMutation.insert(tasks, { id: "task-1", title: "Base" }),
      ],
    });
    await initial.close();
    await storage.createBranch({ name: "feature", from: base.commit });
    const intermediate = await storage.commit({
      branch: "main",
      expectedHead: base.commit,
      mutations: [
        storageMutation.update(tasks, ["task-1"], {
          id: "task-1",
          title: "Intermediate",
        }),
      ],
    });
    const mainHead = await storage.commit({
      branch: "main",
      expectedHead: intermediate.commit,
      mutations: [
        storageMutation.update(tasks, ["task-1"], {
          id: "task-1",
          title: "Main",
        }),
      ],
    });
    const featureHead = await storage.commit({
      branch: "feature",
      expectedHead: base.commit,
      mutations: [
        storageMutation.update(tasks, ["task-1"], {
          id: "task-1",
          title: "Feature",
        }),
      ],
    });

    await storage.collectGarbage();
    await assert.rejects(
      storage.snapshot({ commit: intermediate.commit }),
      HistoryUnavailableError,
    );
    const branchBase = await storage.snapshot({ commit: base.commit });
    assert.equal((await branchBase.get(tasks, ["task-1"]))?.title, "Base");
    await branchBase.close();
    await storage.createBranch({ name: "later", from: base.commit });
    await storage.close();

    const reopened = await openNodeStorage({ directory, schema });
    assert.equal(await reopened.head("main"), mainHead.commit);
    assert.equal(await reopened.head("feature"), featureHead.commit);
    assert.equal(await reopened.head("later"), base.commit);
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the age window retains more than the per-branch minimum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-retention-age-"));

  try {
    const storage = await openNodeStorage({
      directory,
      schema,
      retention: {
        mode: "window",
        keepAtLeast: 1,
        keepYoungerThanMs: Number.MAX_SAFE_INTEGER,
      },
    });
    const initial = await storage.snapshot();
    const first = await storage.commit({
      expectedHead: initial.commit,
      mutations: [
        storageMutation.insert(tasks, { id: "task-1", title: "First" }),
      ],
    });
    await initial.close();
    const second = await storage.commit({
      expectedHead: first.commit,
      mutations: [
        storageMutation.update(tasks, ["task-1"], {
          id: "task-1",
          title: "Second",
        }),
      ],
    });
    await storage.commit({
      expectedHead: second.commit,
      mutations: [
        storageMutation.update(tasks, ["task-1"], {
          id: "task-1",
          title: "Head",
        }),
      ],
    });

    const report = await storage.collectGarbage();
    assert.equal(report.commitsCollected, 0);
    const historical = await storage.snapshot({ commit: second.commit });
    assert.equal((await historical.get(tasks, ["task-1"]))?.title, "Second");
    await historical.close();
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
