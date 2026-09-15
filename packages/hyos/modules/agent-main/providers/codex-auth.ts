import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** ChatGPT subscription credentials the codex backend authenticates with. */
export type CodexAuth = Readonly<{
  accessToken: string;
  accountId: string;
}>;

/** Path to the codex CLI's auth file (overridable for tests and config). */
export function codexAuthFile(
  directory = path.join(os.homedir(), ".codex"),
): string {
  return path.join(directory, "auth.json");
}

function authError(message: string): Error {
  return new Error(`${message} Run \`codex login\` to sign in with ChatGPT.`);
}

type AuthFile = Readonly<{
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: Readonly<{
    access_token?: string;
    account_id?: string;
  }> | null;
}>;

/**
 * Read the ChatGPT subscription auth written by the codex CLI
 * (`~/.codex/auth.json` by default). The codex backend rejects API-key
 * auth, so only ChatGPT mode is accepted.
 */
export async function readCodexAuth(
  authFile = codexAuthFile(),
): Promise<CodexAuth> {
  let content: string;
  try {
    content = await readFile(authFile, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT")
      throw new Error(
        `Codex is not signed in (no auth file at ${authFile}). Run \`codex login\` to sign in with ChatGPT.`,
      );
    throw new Error(`Codex auth file could not be read: ${authFile}`);
  }

  let parsed: AuthFile;
  try {
    parsed = JSON.parse(content) as AuthFile;
  } catch {
    throw authError(`Codex auth file is malformed (${authFile}).`);
  }

  if (parsed.tokens?.access_token && parsed.tokens.account_id) {
    return {
      accessToken: parsed.tokens.access_token,
      accountId: parsed.tokens.account_id,
    };
  }

  if (parsed.OPENAI_API_KEY || parsed.auth_mode === "apikey")
    throw authError(
      `Codex is authenticated with an API key (${authFile}); the codex backend requires ChatGPT subscription auth.`,
    );

  throw authError(`Codex ChatGPT auth is incomplete (${authFile}).`);
}
