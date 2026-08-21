import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SpillLimitExceededError,
  SpillCorruptionError,
  memorySpillStore,
} from "../src/index.js";
import { nodeSpillStore } from "../src/node/index.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

test("spill sessions round-trip ordered records and release their disk budget", async () => {
  const store = memorySpillStore({ maxBytes: 64 });
  const session = await store.createSession({ owner: "sort" });
  const run = await session.writeRun("sort", [bytes("one"), bytes("two")]);

  const values: string[] = [];
  for await (const value of session.readRun(run)) values.push(text(value));
  assert.deepEqual(values, ["one", "two"]);
  assert.equal(store.stats().runs, 1);
  assert.ok(store.stats().usedBytes > 0);

  await session.close();
  assert.deepEqual(store.stats(), {
    maxBytes: 64,
    usedBytes: 0,
    sessions: 0,
    runs: 0,
    bytesWritten: run.bytes,
    bytesRead: run.bytes,
  });
});

test("spill writes fail atomically when the shared disk budget is exhausted", async () => {
  const store = memorySpillStore({ maxBytes: 4 });
  const session = await store.createSession({ owner: "sort" });

  await assert.rejects(
    session.writeRun("sort", [bytes("too large")]),
    SpillLimitExceededError,
  );
  assert.equal(store.stats().usedBytes, 0);
  assert.equal(store.stats().runs, 0);
  await session.close();
});

test("aborted spill sessions stop reads and remain cleanable", async () => {
  const store = memorySpillStore({ maxBytes: 64 });
  const abort = new AbortController();
  const session = await store.createSession({
    owner: "cancelled-query",
    signal: abort.signal,
  });
  const run = await session.writeRun("sort", [bytes("one"), bytes("two")]);
  const iterator = session.readRun(run)[Symbol.asyncIterator]();
  assert.equal(text((await iterator.next()).value!), "one");
  abort.abort(new Error("query cancelled"));
  await assert.rejects(iterator.next(), /query cancelled/);
  await session.close();
  assert.equal(store.stats().usedBytes, 0);
  await store.close();
});

test("the Node spill adapter deletes query files when a session closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-spill-test-"));
  try {
    const store = await nodeSpillStore({ directory, maxBytes: 1024 });
    const session = await store.createSession({ owner: "fetch" });
    const run = await session.writeRun("sort", [bytes("persist briefly")]);
    const values: string[] = [];
    for await (const value of session.readRun(run)) values.push(text(value));
    assert.deepEqual(values, ["persist briefly"]);
    assert.ok((await readdir(directory)).length > 0);

    await session.close();
    assert.deepEqual(await readdir(directory), []);
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Node spill adapter detects truncated frames and still cleans up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hydb-spill-corrupt-"));
  try {
    const store = await nodeSpillStore({ directory, maxBytes: 1024 });
    const session = await store.createSession({ owner: "corrupt" });
    const run = await session.writeRun("hash", [bytes("validated")]);
    const [sessionName] = await readdir(directory);
    const [runName] = await readdir(join(directory, sessionName!));
    await truncate(join(directory, sessionName!, runName!), 3);

    const consume = async (): Promise<void> => {
      for await (const _value of session.readRun(run)) void _value;
    };
    await assert.rejects(consume(), SpillCorruptionError);
    await session.close();
    assert.deepEqual(await readdir(directory), []);
    assert.equal(store.stats().usedBytes, 0);
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
