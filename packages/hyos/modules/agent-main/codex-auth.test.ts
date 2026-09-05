import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexAuthFile, readCodexAuth } from "./providers/codex-auth.js";

const chatgptAuth = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "id.jwt.fixture",
    access_token: "access.jwt.fixture",
    refresh_token: "rt.fixture",
    account_id: "acct-123",
  },
  last_refresh: "2026-09-04T04:23:57.000Z",
};

test("codex auth file resolves under the codex directory", () => {
  assert.equal(
    codexAuthFile("/home/sam/.codex"),
    join("/home/sam/.codex", "auth.json"),
  );
  assert.ok(codexAuthFile().endsWith(join(".codex", "auth.json")));
});

test("reads ChatGPT subscription auth from the configured auth file", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-codex-auth-"));
  try {
    const authFile = join(folder, "auth.json");
    await writeFile(authFile, JSON.stringify(chatgptAuth));
    assert.deepEqual(await readCodexAuth(authFile), {
      accessToken: "access.jwt.fixture",
      accountId: "acct-123",
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("explains when the auth file is missing", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-codex-missing-"));
  try {
    const authFile = join(folder, "auth.json");
    await assert.rejects(
      readCodexAuth(authFile),
      (error: Error) =>
        error.message.startsWith("Codex is not signed in") &&
        error.message.includes(authFile) &&
        error.message.includes("codex login"),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("rejects API-key auth because the backend needs a subscription", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-codex-apikey-"));
  try {
    const authFile = join(folder, "auth.json");
    await writeFile(
      authFile,
      JSON.stringify({ OPENAI_API_KEY: "sk-fixture", tokens: null }),
    );
    await assert.rejects(readCodexAuth(authFile), /API key/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("rejects malformed auth files", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-codex-badjson-"));
  try {
    const authFile = join(folder, "auth.json");
    await writeFile(authFile, "{not json");
    await assert.rejects(readCodexAuth(authFile), /malformed/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("rejects incomplete ChatGPT auth", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyos-codex-partial-"));
  try {
    const authFile = join(folder, "auth.json");
    await writeFile(
      authFile,
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "x" } }),
    );
    await assert.rejects(readCodexAuth(authFile), /incomplete/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
