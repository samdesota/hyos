import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { hydb, id, text, index, storageMutation } from "../dist/src/index.js";
import {
  openNodeStorage,
  openKeyValueStorage,
} from "../dist/src/node/index.js";

const [engine, size] = process.argv.slice(2);
assert.ok(["file", "lmdb"].includes(engine));
assert.ok(["small", "large"].includes(size));
const config =
  size === "small"
    ? {
        rows: 2000,
        payloadBytes: 256,
        writes: 200,
        batchRows: 64,
        batches: 12,
        points: 2000,
        uncachedPoints: 300,
        scans: 8,
        churn: 200,
      }
    : {
        rows: 256,
        payloadBytes: 16384,
        writes: 100,
        batchRows: 16,
        batches: 12,
        points: 500,
        uncachedPoints: 150,
        scans: 8,
        churn: 100,
      };
const items = hydb.table(
  "items",
  {
    id: id().primaryKey(),
    bucket: text().notNull(),
    payload: text().notNull(),
  },
  (c) => [index("by_bucket").on(c.bucket)],
);
const schema = hydb.schema({ items });
const directory = await mkdtemp(
  join(tmpdir(), `hydb-bench-${engine}-${size}-`),
);
const options = {
  directory,
  schema,
  retention: { mode: "window", keepAtLeast: 5 },
  cacheBytes: 16 * 1024 * 1024,
  maxEntries: 64,
};
const openStorage = (cacheBytes = options.cacheBytes) =>
  engine === "file"
    ? openNodeStorage({ ...options, cacheBytes })
    : openKeyValueStorage({ ...options, cacheBytes, gcBatchSize: 128 });
let storage;
let version = 0;
let random = 0x51eed;
const nextIndex = () => {
  random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
  return random % config.rows;
};
const model = new Map();
const makeRow = (i) => {
  const prefix = `${i}:${version++}:`;
  return {
    id: String(i).padStart(8, "0"),
    bucket: String(i % 16),
    payload:
      prefix +
      "abcdefghijklmnopqrstuvwxyz0123456789"
        .repeat(Math.ceil(config.payloadBytes / 36))
        .slice(0, config.payloadBytes - prefix.length),
  };
};
const quantile = (values, p) =>
  values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const summarize = (latencies, wallMs, units = latencies.length) => {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    operations: latencies.length,
    wallMs,
    unitsPerSecond: (units * 1000) / wallMs,
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? 0,
  };
};
let peakHeap = 0,
  peakRss = 0;
const sampleMemory = () => {
  const m = process.memoryUsage();
  peakHeap = Math.max(peakHeap, m.heapUsed);
  peakRss = Math.max(peakRss, m.rss);
};
const sampler = setInterval(sampleMemory, 10);
sampler.unref();
const phases = {};
async function measured(name, count, action, units = count) {
  const times = [],
    start = performance.now();
  for (let i = 0; i < count; i++) {
    const before = performance.now();
    await action(i);
    times.push(performance.now() - before);
    sampleMemory();
  }
  phases[name] = summarize(times, performance.now() - start, units);
  console.error(
    `${engine}/${size}: ${name} ${phases[name].wallMs.toFixed(0)}ms`,
  );
}
async function writeRows(count, insert = false, offset = 0) {
  const values = Array.from({ length: count }, (_, j) =>
    makeRow(insert ? offset + j : (offset + j) % config.rows),
  );
  await storage.commit({
    expectedHead: await storage.head(),
    mutations: values.map((row) =>
      insert
        ? storageMutation.insert(items, row)
        : storageMutation.update(items, [row.id], row),
    ),
  });
  for (const value of values) model.set(value.id, value);
}
async function scan(snapshot) {
  let count = 0;
  for await (const batch of snapshot.scan({ type: "table", table: items }))
    for (const row of batch) {
      count++;
      assert.equal(row.payload.length, config.payloadBytes);
    }
  assert.equal(count, config.rows);
}
async function disk() {
  let logicalBytes = 0,
    allocatedBytes = 0;
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else {
        const s = await stat(child);
        logicalBytes += s.size;
        allocatedBytes += s.blocks * 512;
      }
    }
  }
  await visit(directory);
  return { logicalBytes, allocatedBytes };
}
async function verify() {
  const snapshot = await storage.snapshot();
  try {
    let count = 0;
    for await (const batch of snapshot.scan({ type: "table", table: items }))
      for (const row of batch) {
        assert.deepEqual(row, model.get(row.id));
        count++;
      }
    assert.equal(count, model.size);
  } finally {
    await snapshot.close();
  }
}
async function traffic(withGc) {
  const start = performance.now();
  let gcEnded = false,
    gcMs = 0,
    gcReport;
  let readsDuring = 0,
    writesDuring = 0;
  const reads = [],
    writes = [],
    duringReads = [],
    duringWrites = [];
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  await setImmediate();
  const gc = withGc
    ? storage.collectGarbage().then((report) => {
        gcMs = performance.now() - start;
        gcReport = report;
        gcEnded = true;
      })
    : Promise.resolve();
  const writer = async () => {
    for (let i = 0; i < 100; i++) {
      const before = performance.now(),
        during = withGc && !gcEnded;
      await writeRows(1, false, i % config.rows);
      const ms = performance.now() - before;
      writes.push(ms);
      if (during) duringWrites.push(ms);
      if (withGc && !gcEnded) writesDuring++;
      await setImmediate();
    }
  };
  const reader = async () => {
    for (let i = 0; i < 100; i++) {
      const before = performance.now(),
        during = withGc && !gcEnded;
      const snapshot = await storage.snapshot();
      try {
        const value = await snapshot.get(items, [
          String(i % config.rows).padStart(8, "0"),
        ]);
        assert.ok(value);
      } finally {
        await snapshot.close();
      }
      const ms = performance.now() - before;
      reads.push(ms);
      if (during) duringReads.push(ms);
      if (withGc && !gcEnded) readsDuring++;
      await setImmediate();
    }
  };
  await Promise.all([gc, writer(), reader()]);
  loopDelay.disable();
  sampleMemory();
  const wallMs = performance.now() - start;
  return {
    wallMs,
    gcMs,
    gcReport,
    reads: summarize(reads, wallMs),
    writes: summarize(writes, wallMs),
    readsStartedDuringGc: summarize(duringReads, gcMs),
    writesStartedDuringGc: summarize(duringWrites, gcMs),
    readsCompletedDuringGc: readsDuring,
    writesCompletedDuringGc: writesDuring,
    eventLoopMaxMs: loopDelay.max / 1e6,
  };
}
try {
  storage = await openStorage();
  await measured(
    "seed",
    Math.ceil(config.rows / 64),
    (i) => writeRows(Math.min(64, config.rows - i * 64), true, i * 64),
    config.rows,
  );
  // Unmeasured warmup makes initial loading/JIT less dominant in tiny operations.
  for (let i = 0; i < 20; i++) await writeRows(1, false, i);
  await measured("singleWrite", config.writes, () =>
    writeRows(1, false, nextIndex()),
  );
  await measured(
    "batchWrite",
    config.batches,
    (i) => writeRows(config.batchRows, false, i * config.batchRows),
    config.batches * config.batchRows,
  );
  let snapshot = await storage.snapshot();
  await scan(snapshot);
  await measured("warmPointRead", config.points, async () => {
    assert.ok(
      await snapshot.get(items, [String(nextIndex()).padStart(8, "0")]),
    );
  });
  await measured(
    "tableScan",
    config.scans,
    () => scan(snapshot),
    config.scans * config.rows,
  );
  await measured("indexRead", 32, async (i) => {
    let count = 0;
    for await (const batch of snapshot.scan({
      type: "index",
      table: items,
      index: "by_bucket",
      key: [String(i % 16)],
    }))
      count += batch.length;
    assert.equal(count, config.rows / 16);
  });
  await snapshot.close();
  await storage.close();
  const reopenStart = performance.now();
  storage = await openStorage(0);
  const reopenMs = performance.now() - reopenStart;
  snapshot = await storage.snapshot();
  await measured("cacheDisabledPointRead", config.uncachedPoints, async () => {
    assert.ok(
      await snapshot.get(items, [String(nextIndex()).padStart(8, "0")]),
    );
  });
  await snapshot.close();
  await storage.close();
  storage = await openStorage();
  await measured("churn", config.churn, () => writeRows(1, false, nextIndex()));
  const baseline = await traffic(false);
  const diskBeforeGc = await disk();
  const withGc = await traffic(true);
  const diskAfterTrafficGc = await disk();
  await verify();
  const cleanupStart = performance.now();
  const cleanupReport = await storage.collectGarbage();
  const cleanupMs = performance.now() - cleanupStart;
  const diskAfterCleanup = await disk();
  for (let i = 0; i < 100; i++) await writeRows(1, false, i % config.rows);
  const diskAfterReuseWrites = await disk();
  await verify();
  await storage.close();
  storage = await openStorage();
  await verify();
  sampleMemory();
  const result = {
    engine,
    size,
    config,
    phases,
    reopenMs,
    baseline,
    withGc,
    cleanupMs,
    cleanupReport,
    diskBeforeGc,
    diskAfterTrafficGc,
    diskAfterCleanup,
    diskAfterReuseWrites,
    memory: {
      peakSampledHeapBytes: peakHeap,
      peakSampledRssBytes: peakRss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    },
    verifiedRows: model.size,
  };
  await storage.close();
  storage = undefined;
  console.log(JSON.stringify(result));
} finally {
  clearInterval(sampler);
  await storage?.close();
  await rm(directory, { recursive: true, force: true });
}
