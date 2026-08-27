import assert from "node:assert/strict";
import test from "node:test";

import { createUiAgentClient } from "../src/client.js";
import { createUiAgentServer } from "../src/server.js";

test("serves the bootstrap script and iframe document", async () => {
  let iterationRequest: unknown;
  const server = createUiAgentServer({
    port: 0,
    agent: {
      run(request) {
        iterationRequest = request;
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
        contextElements: [{ tagName: "h2", text: "Revenue" }],
        screenshot: {
          dataUrl: "data:image/png;base64,AA==",
          width: 120,
          height: 80,
        },
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
    assert.deepEqual(iterationRequest, {
      instruction: "Tighten the spacing",
      selection: { tagName: "section", classNames: ["card"] },
      contextElements: [{ tagName: "h2", text: "Revenue" }],
      screenshot: {
        dataUrl: "data:image/png;base64,AA==",
        width: 120,
        height: 80,
      },
      mode: "preview",
    });

    const browserMutationResponse = await fetch(`${url}/trpc/iteration.run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction: "Round this card",
        selection: { tagName: "article" },
        mode: "apply",
      }),
    });
    const browserMutation = (await browserMutationResponse.json()) as {
      result: { data: { id: string; applied: boolean } };
    };
    assert.equal(browserMutation.result.data.id, "iteration-1");

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
    const clientScript = await clientResponse.text();
    assert.match(clientScript, /document\.createElement\("iframe"\)/);
    assert.match(clientScript, /altKey/);
    assert.match(clientScript, /replace\(\/\\s\+\/g/);
    assert.match(clientScript, /collectElements/);
    assert.match(clientScript, /captureRegion/);
    assert.match(clientScript, /contextElements/);

    const overlayResponse = await fetch(`${url}/overlay`);
    const overlayHtml = await overlayResponse.text();
    assert.match(overlayHtml, /Drag around what you want to change/);
    assert.match(overlayHtml, /What should change in this region/);
    assert.match(overlayHtml, /overlay-ready/);

    const screenshotLibraryResponse = await fetch(`${url}/html2canvas.js`);
    assert.equal(screenshotLibraryResponse.status, 200);
    assert.match(
      screenshotLibraryResponse.headers.get("content-type") ?? "",
      /text\/javascript/,
    );
    assert.match(await screenshotLibraryResponse.text(), /html2canvas/);
  } finally {
    await server.close();
  }
});
