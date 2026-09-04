import assert from "node:assert/strict";
import test from "node:test";

import { createVercelGateway, type GatewayRequest } from "../src/gateway.js";

const request: GatewayRequest = {
  model: "test/model",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
  tool_choice: "auto",
  stream: false,
};

test("retries one transient gateway fetch failure", async () => {
  let attempts = 0;
  const gateway = createVercelGateway({
    apiKey: "test-key",
    retryDelayMs: 0,
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("socket disconnected"), {
            code: "ECONNRESET",
          }),
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Hi" } }],
        }),
        { status: 200 },
      );
    },
  });

  assert.deepEqual(await gateway.complete(request), {
    role: "assistant",
    content: "Hi",
  });
  assert.equal(attempts, 2);
});

test("reports the underlying network cause after retrying", async () => {
  const gateway = createVercelGateway({
    apiKey: "test-key",
    retryDelayMs: 0,
    fetch: async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket disconnected"), {
          code: "ECONNRESET",
        }),
      });
    },
  });

  await assert.rejects(
    gateway.complete(request),
    /AI Gateway network request failed after 2 attempts: fetch failed \(ECONNRESET: socket disconnected\)/,
  );
});
