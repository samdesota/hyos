import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openCodeTools } from "./providers/opencode-tools.js";
import { runToolCalls } from "./providers/toolbelt.js";

function editCall(
  id: string,
  oldString: string,
  newString: string,
): Readonly<{ id: string; name: string; arguments: string }> {
  return {
    id,
    name: "edit",
    arguments: JSON.stringify({
      filePath: "doc.md",
      oldString,
      newString,
      explanation: `Rewrite ${oldString} as ${newString}.`,
    }),
  };
}

test("edit and write accept snake_case argument aliases", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-edit-alias-"));
  try {
    await writeFile(join(folder, "doc.md"), "alpha\nbeta\n");
    const tools = new Map(openCodeTools.map((tool) => [tool.name, tool]));
    const results = await runToolCalls({
      folder,
      toolsByName: tools,
      calls: [
        {
          id: "edit-alias",
          name: "edit",
          arguments: JSON.stringify({
            file_path: "doc.md",
            old_string: "alpha",
            new_string: "ALPHA",
            explanation: "Accept Claude-style snake_case names.",
          }),
        },
      ],
      signal: new AbortController().signal,
      activity: async () => {},
      itemIdPrefix: "test-tool",
    });
    assert.equal(results[0].output, "Edit applied successfully.");
    assert.equal(
      await readFile(join(folder, "doc.md"), "utf8"),
      "ALPHA\nbeta\n",
    );
    const written = await runToolCalls({
      folder,
      toolsByName: tools,
      calls: [
        {
          id: "write-alias",
          name: "write",
          arguments: JSON.stringify({
            file_path: "doc.md",
            content: "rewritten\n",
            explanation: "Accept the file_path alias for writes.",
          }),
        },
      ],
      signal: new AbortController().signal,
      activity: async () => {},
      itemIdPrefix: "test-tool",
    });
    assert.equal(written[0].output, "Wrote file successfully.");
    assert.equal(await readFile(join(folder, "doc.md"), "utf8"), "rewritten\n");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("two parallel edits to the same file both land without losing updates", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-parallel-edit-"));
  try {
    await writeFile(join(folder, "doc.md"), "alpha\nbeta\n");
    const results = await runToolCalls({
      folder,
      toolsByName: new Map(openCodeTools.map((tool) => [tool.name, tool])),
      calls: [
        editCall("edit-1", "alpha", "ALPHA"),
        editCall("edit-2", "beta", "BETA"),
      ],
      signal: new AbortController().signal,
      activity: async () => {},
      itemIdPrefix: "test-tool",
    });
    for (const result of results) {
      assert.equal(result.output, "Edit applied successfully.", result.output);
    }
    assert.equal(
      await readFile(join(folder, "doc.md"), "utf8"),
      "ALPHA\nBETA\n",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
