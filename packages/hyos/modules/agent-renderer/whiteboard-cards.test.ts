import assert from "node:assert/strict";
import test from "node:test";

import {
  addWhiteboardCard,
  isBlankCardMarkdown,
  removeWhiteboardCard,
  updateWhiteboardCard,
  type WhiteboardCard,
} from "./whiteboard-cards.js";

const card = (
  id: string,
  overrides: Partial<WhiteboardCard> = {},
): WhiteboardCard => ({
  id,
  x: 10,
  y: 20,
  markdown: `# ${id}`,
  ...overrides,
});

test("cards are added at world coordinates without disturbing others", () => {
  const first = card("a");
  const cards = addWhiteboardCard([first], card("b", { x: -5, y: 100 }));
  assert.deepEqual(cards, [first, { id: "b", x: -5, y: 100, markdown: "# b" }]);
});

test("updating a card rewrites only its markdown", () => {
  const cards = [card("a"), card("b", { markdown: "old" })];
  const updated = updateWhiteboardCard(cards, "b", "new **body**");
  assert.equal(updated[1]?.markdown, "new **body**");
  assert.equal(updated[0], cards[0]);
  // Unknown ids leave the list untouched.
  assert.equal(updateWhiteboardCard(cards, "zzz", "nope"), cards);
});

test("removing a card keeps the rest", () => {
  const cards = [card("a"), card("b")];
  assert.deepEqual(removeWhiteboardCard(cards, "a"), [cards[1]]);
  assert.deepEqual(removeWhiteboardCard(cards, "zzz"), cards);
});

test("blank markdown is detected for delete-on-empty commits", () => {
  assert.equal(isBlankCardMarkdown("   \n\t "), true);
  assert.equal(isBlankCardMarkdown("- a bullet"), false);
});
