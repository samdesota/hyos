import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { createUiAgentClient } from "../src/client.js";
import { createUiAgentServer } from "../src/server.js";

test("serves the bootstrap script and iframe document", async () => {
  const telemetryDirectory = mkdtempSync(join(tmpdir(), "hy-ui-agent-test-"));
  const databasePath = join(telemetryDirectory, "telemetry.sqlite");
  let iterationRequest: unknown;
  let runCount = 0;
  let undoneId: string | undefined;
  const server = createUiAgentServer({
    port: 0,
    model: "thinkingmachines/inkling-small",
    telemetry: { databasePath },
    agent: {
      run(request, report) {
        runCount += 1;
        iterationRequest = request;
        report?.({ phase: "context", message: "Test context collected" });
        return Promise.resolve({
          id: "iteration-1",
          model: "test/model",
          summary: request.instruction,
          edits: [],
          applied: false,
        });
      },
      undo(id) {
        undoneId = id;
        return Promise.resolve({ id, undone: true });
      },
    },
  });
  const url = await server.start();

  try {
    const healthResponse = await fetch(`${url}/health`);
    assert.deepEqual(await healthResponse.json(), { status: "ok" });

    const client = createUiAgentClient({
      serverUrl: url,
      WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    assert.deepEqual(await client.system.health.query(), {
      status: "ok",
      protocol: "trpc",
      version: 1,
    });
    assert.deepEqual(await client.system.configuration.query(), {
      defaultModel: "thinkingmachines/inkling-small",
      models: [
        { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash" },
        { id: "thinkingmachines/inkling-small", label: "Inkling Small" },
        { id: "google/gemini-3-flash", label: "Gemini 3 Flash" },
        { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
        { id: "openai/gpt-5.4-mini-fast", label: "GPT-5.4 Mini Fast" },
      ],
    });
    assert.deepEqual(
      await client.iteration.run.mutate({
        requestId: "request-1",
        instruction: "Tighten the spacing",
        model: "google/gemini-3-flash",
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
    await client.telemetry.ingest.mutate({
      entries: [
        {
          level: "error",
          event: "window.error",
          message: "Test browser failure",
          requestId: "request-1",
          timestamp: Date.now(),
        },
      ],
    });
    const telemetry = await client.telemetry.recent.query({ limit: 100 });
    assert.ok(
      telemetry.some(
        (entry) =>
          entry.event === "iteration.completed" &&
          entry.requestId === "request-1",
      ),
    );
    assert.ok(
      telemetry.some(
        (entry) =>
          entry.event === "window.error" && entry.source === "frontend",
      ),
    );
    assert.equal(existsSync(databasePath), true);
    assert.deepEqual(iterationRequest, {
      instruction: "Tighten the spacing",
      model: "google/gemini-3-flash",
      selection: { tagName: "section", classNames: ["card"] },
      contextElements: [{ tagName: "h2", text: "Revenue" }],
      screenshot: {
        dataUrl: "data:image/png;base64,AA==",
        width: 120,
        height: 80,
      },
      mode: "preview",
    });

    const activityEvents: Array<{ phase: string; message: string }> = [];
    const activityDone = new Promise<void>((resolve, reject) => {
      client.iteration.activity.subscribe(
        { requestId: "request-1" },
        {
          onData(event) {
            activityEvents.push(event);
            if (event.phase === "complete") resolve();
          },
          onError: reject,
        },
      );
    });
    await activityDone;
    assert.deepEqual(
      activityEvents.map(({ phase, message }) => ({ phase, message })),
      [
        { phase: "context", message: "Test context collected" },
        { phase: "complete", message: "Iteration complete" },
      ],
    );

    const browserMutationResponse = await fetch(`${url}/trpc/iteration.run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request-2",
        instruction: "Round this card",
        selection: { tagName: "article" },
        mode: "apply",
      }),
    });
    const browserMutation = (await browserMutationResponse.json()) as {
      result: { data: { id: string; applied: boolean } };
    };
    assert.equal(browserMutation.result.data.id, "iteration-1");
    await client.iteration.run.mutate({
      requestId: "request-2",
      instruction: "This duplicate must not run",
      selection: { tagName: "article" },
      mode: "apply",
    });
    assert.equal(runCount, 2);
    assert.deepEqual(
      await client.iteration.undo.mutate({ id: "iteration-1" }),
      {
        id: "iteration-1",
        undone: true,
      },
    );
    assert.equal(undoneId, "iteration-1");

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
    assert.equal(clientResponse.status, 200);
    assert.match(clientScript, /createElement\("iframe"\)/);
    assert.match(clientScript, /altKey/);
    assert.match(clientScript, /KeyE/);
    assert.match(clientScript, /ctrlKey/);
    assert.match(clientScript, /metaKey/);
    assert.match(clientScript, /hyos-ui-agent-launcher/);
    assert.match(clientScript, /cancel-overlay/);
    assert.match(clientScript, /data-source-loc/);
    assert.match(clientScript, /html2canvas/);
    assert.match(clientScript, /contextElements/);
    assert.match(clientScript, /sessionStorage/);
    assert.match(clientScript, /restore-iteration/);
    assert.match(clientScript, /continuationId/);

    const overlayResponse = await fetch(`${url}/overlay`);
    const overlayHtml = await overlayResponse.text();
    assert.match(overlayHtml, /id="root"/);
    assert.match(overlayHtml, /src="\.\/overlay\.js"/);
    assert.match(overlayHtml, /href="\.\/overlay\.css"/);
    assert.doesNotMatch(overlayHtml, /Drag around what you want to change/);

    const overlayScriptResponse = await fetch(`${url}/overlay.js`);
    const overlayScript = await overlayScriptResponse.text();
    assert.equal(overlayScriptResponse.status, 200);
    assert.match(overlayScript, /Drag around what you want to change/);
    assert.match(overlayScript, /What should change in this region/);
    assert.match(overlayScript, /Agent activity/);
    assert.match(overlayScript, /iteration\.activity/);
    assert.match(overlayScript, /Undo/);
    assert.match(overlayScript, /Dismiss/);
    assert.match(overlayScript, /What should change next/);
    assert.match(overlayScript, /Make follow-up/);
    assert.match(overlayScript, /Loading models/);
    assert.match(overlayScript, /Last change used/);

    const overlayStylesResponse = await fetch(`${url}/overlay.css`);
    assert.equal(overlayStylesResponse.status, 200);
    assert.match(
      overlayStylesResponse.headers.get("content-type") ?? "",
      /text\/css/,
    );
    const overlayStyles = await overlayStylesResponse.text();
    assert.match(overlayStyles, /\.prompt-panel/);
    assert.match(overlayStyles, /\.model-picker/);

    assert.equal((await fetch(`${url}/activity-client.js`)).status, 404);
    assert.equal((await fetch(`${url}/html2canvas.js`)).status, 404);
  } finally {
    await server.close();
    rmSync(telemetryDirectory, { recursive: true, force: true });
  }
});
