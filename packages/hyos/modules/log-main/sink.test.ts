import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLogSink } from "./sink.js";

const makeDir = (): string => mkdtempSync(path.join(tmpdir(), "hyos-log-"));

test("appends JSONL entries with ts, level, source, msg", () => {
  const dir = makeDir();
  const fixed = new Date("2026-09-14T12:00:00.123Z");
  const sink = createLogSink({ directory: dir, now: () => fixed });

  sink.log("info", "main", "hello");
  sink.log("warn", "ui-view", "careful");

  const lines = readFileSync(sink.path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), {
    ts: fixed.toISOString(),
    level: "info",
    source: "main",
    msg: "hello",
  });
  assert.equal(JSON.parse(lines[1]!).source, "ui-view");
  assert.equal(JSON.parse(lines[1]!).level, "warn");
  rmSync(dir, { recursive: true, force: true });
});

test("creates the directory when missing", () => {
  const parent = makeDir();
  const sink = createLogSink({ directory: path.join(parent, "nested") });
  sink.log("info", "main", "created");
  assert.ok(readFileSync(sink.path, "utf8").includes('"msg":"created"'));
  rmSync(parent, { recursive: true, force: true });
});

test("rotates by size, keeping the newest files", () => {
  const dir = makeDir();
  const sink = createLogSink({
    directory: dir,
    maxBytes: 200,
    keepFiles: 3,
  });

  for (let i = 0; i < 40; i += 1) sink.log("info", "test", `entry ${i}`);

  const files = readdirSync(dir).sort();
  assert.ok(files.includes("hyos.log"), "active log exists");
  assert.ok(files.includes("hyos.log.1"), "first rotation exists");
  // keepFiles=3 keeps at most the active file plus 2 rotated files.
  assert.equal(files.filter((f) => f.startsWith("hyos.log")).length, 3);
  assert.ok(!files.includes("hyos.log.3"), "oldest rotated file is dropped");
  rmSync(dir, { recursive: true, force: true });
});
