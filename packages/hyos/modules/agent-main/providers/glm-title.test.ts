import assert from "node:assert/strict";
import test from "node:test";

import { createGlmProvider } from "./glm.js";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const completion = (content: string): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const providerWith = (fetch: FetchLike) =>
  createGlmProvider({ apiKey: "test-key", fetch });

test("generateTitle sends a single non-streaming low-reasoning call and cleans the reply", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const provider = providerWith(async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return completion('  "Fix login race condition"\n');
  });

  const title = await provider.generateTitle!("Help me debug auth");
  assert.equal(title, "Fix login race condition");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/chat/completions"));
  assert.equal(calls[0].body.model, "zai/glm-5.3-flash");
  assert.equal(calls[0].body.stream, false);
  assert.deepEqual(calls[0].body.reasoning, { effort: "low" });
  const messages = calls[0].body.messages as readonly {
    role: string;
    content: string;
  }[];
  assert.deepEqual(messages, [
    { role: "system", content: messages[0]?.content },
    { role: "user", content: "Help me debug auth" },
  ]);
});

test("generateTitle keeps only the first line and strips markdown wrapping", async () => {
  const provider = providerWith(async () =>
    completion("## Ship the parser\nBonus!"),
  );
  const title = await provider.generateTitle!("Rewrite hydb spill");
  assert.equal(title, "Ship the parser");
});

test("generateTitle resolves to null when the request fails", async () => {
  const provider = providerWith(
    async () => new Response("boom", { status: 500 }),
  );
  assert.equal(await provider.generateTitle!("Anything"), null);
});

test("generateTitle resolves to null when the request throws", async () => {
  const provider = providerWith(async () => {
    throw new Error("offline");
  });
  assert.equal(await provider.generateTitle!("Anything"), null);
});

test("generateTitle resolves to null on an empty reply", async () => {
  const provider = providerWith(async () => completion("   \n"));
  assert.equal(await provider.generateTitle!("X"), null);
});

test("generateTitle resolves to null when the caller's signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = providerWith(async (_url, init) => {
    if (init?.signal?.aborted) throw new Error("aborted");
    await new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
      setTimeout(() => resolve(completion("Unused")), 20);
    });
    return completion("Unused");
  });
  assert.equal(await provider.generateTitle!("X", controller.signal), null);
});
