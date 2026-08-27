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

test("inspects the project and applies a submitted exact replacement", async () => {
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
  const agent = createQuickIterationAgent({ projectRoot: root, gateway });

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
    contentText(gateway.requests[0]?.messages.at(-1)),
    /data:image\/png;base64,AA==/,
  );
});
