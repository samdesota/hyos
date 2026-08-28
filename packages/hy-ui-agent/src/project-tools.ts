import { readFile, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import type { TextReplacement } from "./agent-types.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "dist",
  "node_modules",
  ".next",
  "coverage",
]);
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".scss",
  ".ts",
  ".tsx",
  ".vue",
]);
const MAX_FILE_BYTES = 80_000;

async function walk(root: string, directory = root): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".storybook") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name))
        files.push(...(await walk(root, path)));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
      files.push(relative(root, path));
    }
  }
  return files;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export interface ProjectTools {
  listFiles(pattern?: string): Promise<string[]>;
  searchCode(query: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  applyEdits(edits: TextReplacement[]): Promise<void>;
}

export function createProjectTools(projectRoot: string): ProjectTools {
  let knownFiles: Promise<string[]> | undefined;
  const root = resolve(projectRoot);
  const canonicalRoot = realpath(root);
  const files = () => (knownFiles ??= walk(root));

  async function resolveFile(path: string): Promise<string> {
    const candidate = resolve(root, path);
    if (!isInside(root, candidate))
      throw new Error(`Path escapes project root: ${path}`);
    const canonical = await realpath(candidate);
    if (!isInside(await canonicalRoot, canonical))
      throw new Error(`Path escapes project root: ${path}`);
    return canonical;
  }

  async function readProjectFile(path: string): Promise<string> {
    const content = await readFile(await resolveFile(path), "utf8");
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      throw new Error(`File is too large for the quick agent: ${path}`);
    }
    return content;
  }

  return {
    async listFiles(pattern) {
      const all = await files();
      if (!pattern) return all.slice(0, 250);
      const query = pattern.toLowerCase();
      return all
        .filter((path) => path.toLowerCase().includes(query))
        .slice(0, 250);
    },
    async searchCode(query) {
      if (!query.trim()) throw new Error("Search query cannot be empty");
      const matches: string[] = [];
      for (const path of await files()) {
        let content: string;
        try {
          content = await readProjectFile(path);
        } catch {
          continue;
        }
        const lines = content.split("\n");
        lines.forEach((line, index) => {
          if (
            matches.length < 80 &&
            line.toLowerCase().includes(query.toLowerCase())
          ) {
            matches.push(`${path}:${index + 1}: ${line.trim().slice(0, 240)}`);
          }
        });
        if (matches.length >= 80) break;
      }
      return matches;
    },
    readFile: readProjectFile,
    async applyEdits(edits) {
      const updates = new Map<string, string>();
      for (const edit of edits) {
        const path = await resolveFile(edit.path);
        const original =
          updates.get(path) ?? (await readProjectFile(edit.path));
        const first = original.indexOf(edit.find);
        if (first === -1)
          throw new Error(`Text to replace was not found in ${edit.path}`);
        if (original.indexOf(edit.find, first + edit.find.length) !== -1) {
          throw new Error(`Text to replace is not unique in ${edit.path}`);
        }
        updates.set(
          path,
          original.slice(0, first) +
            edit.replace +
            original.slice(first + edit.find.length),
        );
      }
      await Promise.all(
        [...updates].map(([path, content]) => writeFile(path, content, "utf8")),
      );
    },
  };
}
