import assert from "node:assert/strict";
import test from "node:test";

import { userMessage } from "./codex-responses.js";

const content = (
  message: ReturnType<typeof userMessage>,
): readonly unknown[] => {
  assert.ok("content" in message);
  return message.content;
};

test("userMessage emits input_image parts after the text part", () => {
  const message = userMessage("Look at this", [
    { mimeType: "image/png", base64: "AAAA" },
    { mimeType: "image/jpeg", base64: "BBBB" },
  ]);
  assert.deepEqual(content(message), [
    { type: "input_text", text: "Look at this" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    { type: "input_image", image_url: "data:image/jpeg;base64,BBBB" },
  ]);
});

test("userMessage without images is text-only", () => {
  const message = userMessage("Hello");
  assert.deepEqual(content(message), [{ type: "input_text", text: "Hello" }]);
});
