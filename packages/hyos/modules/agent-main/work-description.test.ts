import assert from "node:assert/strict";
import test from "node:test";

import { describeWork } from "./work-description.js";

test("substantive prompts describe the work", () => {
  assert.equal(
    describeWork("Fix the sidebar spinner flicker", null),
    "Fix the sidebar spinner flicker",
  );
  assert.equal(
    describeWork("Investigate failing tests\nsecond line", null),
    "Investigate failing tests",
  );
});

test("plan blocks and code fences never leak into the phrase", () => {
  const prompt = [
    "Update the plan",
    "",
    "```hyos-plan",
    "- [ ] Add statusDetail column",
    "```",
  ].join("\n");
  assert.equal(describeWork(prompt, null), "Update the plan");
});

test("continuation prompts fall back to the previous response", () => {
  const previous = [
    "Done — the sidebar now shows a spinner while running.",
    "",
    "```hyos-plan",
    "- [x] Show spinner",
    "```",
  ].join("\n");
  assert.equal(
    describeWork("continue", previous),
    "Done the sidebar now shows",
  );
  assert.equal(
    describeWork("go ahead", previous),
    "Done the sidebar now shows",
  );
});

test("returns null when there is nothing usable", () => {
  assert.equal(describeWork("", null), null);
  assert.equal(describeWork("```\ncode only\n```", null), null);
});
