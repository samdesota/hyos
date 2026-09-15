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

test("generateStatusDetail sends a single non-streaming low-reasoning call with the prompt alone", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const provider = providerWith(async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return completion("Fix login race condition\n");
  });

  const detail = await provider.generateStatusDetail!(
    "Fix the auth bug where tokens expire mid-session",
    null,
  );
  assert.equal(detail, "Fix login race condition");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/chat/completions"));
  assert.equal(calls[0].body.model, "zai/glm-5.3-flash");
  assert.equal(calls[0].body.stream, false);
  assert.deepEqual(calls[0].body.reasoning, { effort: "low" });
  const messages = calls[0].body.messages as readonly {
    role: string;
    content: string;
  }[];
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  assert.deepEqual(messages[1], {
    role: "user",
    content: "Fix the auth bug where tokens expire mid-session",
  });
});

test("generateStatusDetail includes the previous response tail for continuations", async () => {
  const calls: { body: Record<string, unknown> }[] = [];
  const provider = providerWith(async (_url, init) => {
    calls.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return completion("Investigate failing tests");
  });

  const tail = "x".repeat(2000);
  await provider.generateStatusDetail!("continue", `Earlier text. ${tail}`);
  const messages = calls[0]?.body.messages as readonly {
    role: string;
    content: string;
  }[];
  const userContent = messages[1]?.content ?? "";
  assert.ok(userContent.startsWith("continue"));
  assert.ok(userContent.includes(tail.slice(-600)));
  assert.ok(!userContent.includes("Earlier text."));
});

test("generateStatusDetail resolves to null when the request fails", async () => {
  const provider = providerWith(
    async () => new Response("boom", { status: 500 }),
  );
  assert.equal(await provider.generateStatusDetail!("Anything", null), null);
});

test("generateStatusDetail resolves to null when the request throws", async () => {
  const provider = providerWith(async () => {
    throw new Error("offline");
  });
  assert.equal(await provider.generateStatusDetail!("Anything", null), null);
});

test("generateStatusDetail resolves to null on an empty reply", async () => {
  const provider = providerWith(async () => completion("   \n"));
  assert.equal(await provider.generateStatusDetail!("X", null), null);
});
