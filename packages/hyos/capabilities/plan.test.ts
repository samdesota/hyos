import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPlanBlock,
  parsePlanBlock,
  parsePlanTasks,
  stripPlanBlocks,
} from "./plan.js";

test("plan blocks parse into tasks with their done state", () => {
  const content = [
    "Here is the plan so far.",
    "",
    "```hyos-plan",
    "- [x] Plan format + prompt policy",
    "- [ ] Plan parser",
    "* [X] Also done",
    "- not a task",
    "- [ ] ",
    "```",
    "",
    "Anything after the block.",
  ].join("\n");

  assert.deepEqual(parsePlanBlock(content), [
    { text: "Plan format + prompt policy", done: true },
    { text: "Plan parser", done: false },
    { text: "Also done", done: true },
  ]);
  assert.deepEqual(parsePlanTasks("- [ ] Only this"), [
    { text: "Only this", done: false },
  ]);
});

test("the last complete plan block wins and unterminated fences never parse", () => {
  const block = (tasks: string[]): string =>
    ["```hyos-plan", ...tasks, "```"].join("\n");
  const content = [
    block(["- [ ] Stale task"]),
    "middle",
    block(["- [x] Fresh task", "- [ ] Next task"]),
  ].join("\n");
  assert.deepEqual(parsePlanBlock(content), [
    { text: "Fresh task", done: true },
    { text: "Next task", done: false },
  ]);

  assert.equal(parsePlanBlock("No plan here at all."), null);
  assert.equal(
    parsePlanBlock(["```hyos-plan", "- [ ] Streaming…"].join("\n")),
    null,
  );
});

test("stripPlanBlocks removes complete blocks and keeps the rest", () => {
  const content = [
    "Before.",
    "",
    "```hyos-plan",
    "- [x] One",
    "```",
    "",
    "Middle.",
    "",
    "~~~hyos-plan",
    "- [ ] Two",
    "~~~",
    "",
    "After.",
  ].join("\n");

  assert.equal(
    stripPlanBlocks(content),
    ["Before.", "", "", "", "Middle.", "", "", "", "After."].join("\n"),
  );
  assert.equal(
    stripPlanBlocks("```hyos-plan\n- [ ] open"),
    "```hyos-plan\n- [ ] open",
  );
});

test("formatPlanBlock round-trips through the parser", () => {
  const tasks = [
    { text: "Plan format + prompt policy", done: true },
    { text: "Plan parser", done: false },
  ];
  const block = formatPlanBlock(tasks);
  assert.match(block, /^```hyos-plan\n/);
  assert.deepEqual(parsePlanBlock(block), tasks);
});
