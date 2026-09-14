import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLogSink, attachViewConsoleLogging } from "./sink.js";

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
  rmSync(dir, { recursive: true, force: true });
});

test("routes console-message events into the sink with mapped levels", () => {
  const dir = makeDir();
  const sink = createLogSink({ directory: dir });
  const handlers = new Map<
    string,
    (event: unknown, ...rest: unknown[]) => void
  >();
  const fakeContents = {
    on: (name: string, handler: (event: unknown, ...rest: unknown[]) => void) =>
      handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
  };
  const dispose = attachViewConsoleLogging(
    sink,
    fakeContents as never,
    "ui-view",
  );

  handlers.get("console-message")?.({ level: "warning", message: "careful" });
  handlers.get("console-message")?.({ level: "error", message: "boom" });
  // Legacy positional signature (numbered levels) still maps.
  handlers.get("console-message")?.({}, 0, "verbose text");
  dispose();
  handlers.get("console-message")?.({ level: "info", message: "ignored" });

  const lines = readFileSync(sink.path, "utf8").trim().split("\n");
  const entries = lines.map((line) => JSON.parse(line));
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map(({ level, source, msg }) => ({ level, source, msg })),
    [
      { level: "warn", source: "ui-view", msg: "careful" },
      { level: "error", source: "ui-view", msg: "boom" },
      { level: "debug", source: "ui-view", msg: "verbose text" },
    ],
  );
  for (const entry of entries) assert.equal(typeof entry.ts, "string");
  rmSync(dir, { recursive: true, force: true });
});
