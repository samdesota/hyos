/**
 * Resolve the ripgrep binary bundled with the app via `@vscode/ripgrep`,
 * falling back to a system `rg` on PATH when the platform package is
 * unavailable (e.g. an unusual install or test environment).
 *
 * The package is ESM, so resolve lazily with a dynamic import and cache the
 * result: nothing loads until a tool actually executes, and module loading
 * (tsx CJS require) stays unaffected.
 */
let cachedPath: string | undefined;

export async function resolveRgBinary(): Promise<string> {
  cachedPath ??= await import("@vscode/ripgrep")
    .then(({ rgPath }) => rgPath)
    .catch(() => "rg");
  return cachedPath;
}
