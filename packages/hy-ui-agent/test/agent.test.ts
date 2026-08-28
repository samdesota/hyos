import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createQuickIterationAgent } from "../src/agent.js";
import type {
  GatewayMessage,
  GatewayRequest,
  GatewayTransport,
} from "../src/gateway.js";

class ScriptedGateway implements GatewayTransport {
  requests: GatewayRequest[] = [];
  constructor(private readonly messages: GatewayMessage[]) {}

  complete(request: GatewayRequest): Promise<GatewayMessage> {
    this.requests.push(structuredClone(request));
    const message = this.messages.shift();
    if (!message) throw new Error("No scripted response");
    return Promise.resolve(message);
  }
}

function toolCall(name: string, args: object): GatewayMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `call-${name}`,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function contentText(message: GatewayMessage | undefined): string {
  return typeof message?.content === "string"
    ? message.content
    : JSON.stringify(message?.content ?? "");
}

test("applies a submitted replacement and can undo it", async () => {
  const root = await mkdtemp(join(tmpdir(), "hy-ui-agent-"));
  const file = join(root, "button.tsx");
  await writeFile(
    file,
    'export const Button = () => <button class="small">Save</button>;\n',
  );
  const gateway = new ScriptedGateway([
    toolCall("search_code", { query: "Save" }),
    toolCall("read_file", { path: "button.tsx" }),
    toolCall("submit_edits", {
      summary: "Make the Save button larger",
      edits: [
        {
          path: "button.tsx",
          find: 'class="small"',
          replace: 'class="large"',
        },
      ],
    }),
    toolCall("submit_edits", {
      summary: "Use a medium button instead",
      edits: [
        {
          path: "button.tsx",
          find: 'class="small"',
          replace: 'class="medium"',
        },
      ],
    }),
  ]);
  const agent = createQuickIterationAgent({ projectRoot: root, gateway });

  const result = await agent.run({
    instruction: "Make this button larger",
    selection: { tagName: "button", text: "Save" },
    mode: "apply",
  });

  assert.equal(result.applied, true);
  assert.equal(result.edits[0]?.path, "button.tsx");
  assert.match(await readFile(file, "utf8"), /class="large"/);
  assert.match(
    contentText(gateway.requests[1]?.messages.at(-1)),
    /button\.tsx:1/,
  );
  assert.match(
    contentText(gateway.requests[2]?.messages.at(-1)),
    /class=\\"small\\"/,
  );

  assert.deepEqual(await agent.undo?.(result.id), {
    id: result.id,
    undone: true,
  });
  assert.match(await readFile(file, "utf8"), /class="small"/);

  const followUp = await agent.run({
    instruction: "Actually, make it medium",
    continuationId: result.id,
    selection: { tagName: "button", text: "Save" },
    mode: "apply",
  });

  assert.match(await readFile(file, "utf8"), /class="medium"/);
  assert.match(
    JSON.stringify(gateway.requests[3]?.messages),
    /Make the Save button larger/,
  );
  assert.match(
    JSON.stringify(gateway.requests[3]?.messages),
    /user undid the previous change/,
  );
  assert.match(
    contentText(gateway.requests[3]?.messages.at(-1)),
    /Follow-up instruction.*Actually, make it medium/s,
  );
  assert.notEqual(followUp.id, result.id);
});

test("preview returns edits without changing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "hy-ui-agent-"));
  const file = join(root, "styles.css");
  await writeFile(file, ".card { padding: 8px; }\n");
  const gateway = new ScriptedGateway([
    toolCall("submit_edits", {
      summary: "Increase card padding",
      edits: [
        {
          path: "styles.css",
          find: "padding: 8px",
          replace: "padding: 12px",
        },
      ],
    }),
  ]);
  const agent = createQuickIterationAgent({
    projectRoot: root,
    gateway,
    reasoning: "minimal",
    providerOrder: ["parasail", "morph", "baseten"],
  });

  const result = await agent.run({
    instruction: "Add more space",
    selection: {
      tagName: "div",
      classNames: ["card"],
      sourceHint: "styles.css:1:1",
    },
    contextElements: [{ tagName: "span", text: "Card title" }],
    screenshot: {
      dataUrl: "data:image/png;base64,AA==",
      width: 20,
      height: 20,
    },
  });

  assert.equal(result.applied, false);
  assert.equal(await readFile(file, "utf8"), ".card { padding: 8px; }\n");
  assert.match(
    contentText(gateway.requests[0]?.messages.at(-1)),
    /--- styles\.css ---/,
  );
  assert.match(
    contentText(gateway.requests[0]?.messages[0]),
    /Treat those files as already inspected/,
  );
  assert.match(
    contentText(gateway.requests[0]?.messages[0]),
    /submit_edits immediately as your first and only tool call/,
  );
  assert.match(
    contentText(gateway.requests[0]?.messages.at(-1)),
    /data:image\/png;base64,AA==/,
  );
  assert.deepEqual(gateway.requests[0]?.reasoning, { effort: "minimal" });
  assert.deepEqual(gateway.requests[0]?.providerOptions, {
    gateway: {
      order: ["parasail", "morph", "baseten"],
      only: ["parasail", "morph", "baseten"],
    },
  });
});
