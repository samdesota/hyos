import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

import {
  editFile,
  editInputSchema,
  writeInputSchema,
  writeWholeFile,
} from "./providers/claude-edit-tools.js";

test("Edit and Write require an explanation without changing their native fields", () => {
  const edit = z.object(editInputSchema);
  const write = z.object(writeInputSchema);
  assert.equal(
    edit.safeParse({ file_path: "app.txt", old_string: "a", new_string: "b" })
      .success,
    false,
  );
  assert.equal(
    write.safeParse({ file_path: "app.txt", content: "content" }).success,
    false,
  );
  assert.equal(
    edit.safeParse({
      file_path: "app.txt",
      old_string: "a",
      new_string: "b",
      explanation: "Rename the value.",
    }).success,
    true,
  );
});

test("Edit preserves Claude's replacement semantics", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-edit-"));
  try {
    await writeFile(join(folder, "app.txt"), "before\n");
    await editFile(folder, {
      file_path: "app.txt",
      old_string: "before",
      new_string: "after",
      explanation: "Rename the visible state.",
    });
    assert.equal(await readFile(join(folder, "app.txt"), "utf8"), "after\n");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("Write creates parent directories and complete file content", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-write-"));
  try {
    await writeWholeFile(folder, {
      file_path: "nested/app.txt",
      content: "created\n",
      explanation: "Create the new module.",
    });
    assert.equal(
      await readFile(join(folder, "nested/app.txt"), "utf8"),
      "created\n",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("Edit and Write reject paths outside the workspace", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-path-"));
  try {
    await assert.rejects(
      () =>
        writeWholeFile(folder, {
          file_path: "../outside.txt",
          content: "nope",
          explanation: "Attempt an invalid write.",
        }),
      /outside the workspace/,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
