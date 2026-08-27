import assert from "node:assert/strict";
import test from "node:test";

import { createUiAgentClient } from "../src/client.js";
import { createUiAgentServer } from "../src/server.js";

test("serves the bootstrap script and iframe document", async () => {
  const server = createUiAgentServer({
    port: 0,
    agent: {
      run(request) {
        return Promise.resolve({
          id: "iteration-1",
          model: "test/model",
          summary: request.instruction,
          edits: [],
          applied: false,
        });
      },
    },
  });
  const url = await server.start();

  try {
    const healthResponse = await fetch(`${url}/health`);
    assert.deepEqual(await healthResponse.json(), { status: "ok" });

    const client = createUiAgentClient({ serverUrl: url });
    assert.deepEqual(await client.system.health.query(), {
      status: "ok",
      protocol: "trpc",
      version: 1,
    });
    assert.deepEqual(
      await client.iteration.run.mutate({
        instruction: "Tighten the spacing",
        selection: { tagName: "section", classNames: ["card"] },
        mode: "preview",
      }),
      {
        id: "iteration-1",
        model: "test/model",
        summary: "Tighten the spacing",
        edits: [],
        applied: false,
      },
    );

    const preflightResponse = await fetch(`${url}/trpc/system.health`, {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(preflightResponse.status, 204);
    assert.equal(
      preflightResponse.headers.get("access-control-allow-origin"),
      "*",
    );

    const clientResponse = await fetch(`${url}/client.js`);
    assert.match(
      await clientResponse.text(),
      /document\.createElement\("iframe"\)/,
    );

    const overlayResponse = await fetch(`${url}/overlay`);
    const overlayHtml = await overlayResponse.text();
    assert.match(overlayHtml, /UI agent connected/);
    assert.match(overlayHtml, /overlay-ready/);
  } finally {
    await server.close();
  }
});
