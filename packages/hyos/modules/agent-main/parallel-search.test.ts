import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createParallelSearch } from "./providers/parallel-search.js";
import { createGlmProvider } from "./providers/glm.js";

const input = {
  objective: "Find documentation",
  search_queries: ["Parallel search documentation"],
};

test("search authenticates, forwards cancellation and bounds source excerpts", async () => {
  const controller = new AbortController();
  const tool = createParallelSearch({
    apiKey: "test-secret",
    fetch: async (url, init) => {
      assert.equal(url, "https://api.parallel.ai/v1/search");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "test-secret");
      assert.equal(init?.signal, controller.signal);
      assert.equal(JSON.parse(String(init?.body)).max_chars_total, 12000);
      return Response.json({
        results: [
          {
            title: "Docs",
            url: "https://example.com",
            excerpts: ["x".repeat(20000)],
          },
        ],
      });
    },
  });
  const result = await tool.execute("/tmp", input, controller.signal);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.results[0].excerpt.length, 12000);
  assert.equal(parsed.results[0].title, "Docs");
  assert.equal(parsed.results[0].url, "https://example.com");
  assert.ok(!result.output.includes("test-secret"));
});

test("search errors never echo remote error bodies", async () => {
  const tool = createParallelSearch({
    apiKey: "secret",
    fetch: async () => new Response("secret", { status: 401 }),
  });
  await assert.rejects(
    tool.execute("/tmp", input, new AbortController().signal),
    /^Error: Parallel search failed \(HTTP 401\)\.$/,
  );
});

test("search propagates an active abort without exposing fetch errors", async () => {
  const controller = new AbortController();
  const tool = createParallelSearch({
    apiKey: "secret",
    fetch: async () => {
      controller.abort();
      throw new Error("secret");
    },
  });
  await assert.rejects(tool.execute("/tmp", input, controller.signal), {
    name: "AbortError",
  });
});

test("search validates arguments before requesting and rejects malformed results", async () => {
  let calls = 0;
  const tool = createParallelSearch({
    apiKey: "secret",
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(
    tool.execute(
      "/tmp",
      { ...input, search_queries: [] },
      new AbortController().signal,
    ),
    /requires an objective/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    tool.execute("/tmp", input, new AbortController().signal),
    /invalid response/,
  );
});

test("search loads its key from the configured environment file", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-parallel-"));
  const prior = process.env.PARALLEL_API_KEY;
  delete process.env.PARALLEL_API_KEY;
  try {
    const environmentFile = join(folder, ".env");
    await writeFile(environmentFile, "PARALLEL_API_KEY='fixture-key'\n");
    const tool = createParallelSearch({
      environmentFile,
      fetch: async (_url, init) => {
        assert.equal(
          new Headers(init?.headers).get("x-api-key"),
          "fixture-key",
        );
        return Response.json({ results: [] });
      },
    });
    assert.deepEqual(
      JSON.parse(
        (await tool.execute(folder, input, new AbortController().signal))
          .output,
      ).results,
      [],
    );
    let rounds = 0;
    let searches = 0;
    const labels: string[] = [];
    const provider = createGlmProvider({
      apiKey: "gateway-fixture",
      environmentFile,
      fetch: async (url, init) => {
        if (String(url).includes("api.parallel.ai")) {
          searches++;
          assert.equal(
            new Headers(init?.headers).get("x-api-key"),
            "fixture-key",
          );
          return Response.json({
            results: [
              {
                title: "Docs",
                url: "https://example.com",
                excerpts: ["Source excerpt"],
              },
            ],
          });
        }
        rounds++;
        if (rounds === 2) {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.messages.at(-1).role, "tool");
          assert.match(body.messages.at(-1).content, /Source excerpt/);
        }
        const delta =
          rounds === 1
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "search-1",
                    function: {
                      name: "web_search",
                      arguments: JSON.stringify(input),
                    },
                  },
                ],
              }
            : { content: "Found the documentation." };
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
        );
      },
    });
    await provider.run(
      {
        prompt: "Find docs",
        folder,
        modelId: "glm",
        reasoningEffort: "medium",
        providerSessionId: null,
      },
      {
        session() {},
        response() {},
        activity(_id, activity) {
          if (activity.type === "tool") labels.push(activity.label);
        },
      },
      new AbortController().signal,
    );
    assert.equal(rounds, 2);
    assert.equal(searches, 1);
    assert.deepEqual(labels, ["Searched the web", "Searched the web"]);
    await assert.rejects(
      createParallelSearch().execute(
        folder,
        input,
        new AbortController().signal,
      ),
      /not configured/,
    );
  } finally {
    if (prior !== undefined) process.env.PARALLEL_API_KEY = prior;
    await rm(folder, { recursive: true, force: true });
  }
});
