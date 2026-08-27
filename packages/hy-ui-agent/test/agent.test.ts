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
    gateway.requests[1]?.messages.at(-1)?.content ?? "",
    /button\.tsx:1/,
  );
  assert.match(
    gateway.requests[2]?.messages.at(-1)?.content ?? "",
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
    selection: { tagName: "div", classNames: ["card"] },
  });

  assert.equal(result.applied, false);
  assert.equal(await readFile(file, "utf8"), ".card { padding: 8px; }\n");
});
