import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

import type { RepositorySpec } from "./project-tools.js";

const execute = promisify(execFile);

export interface FolderPicker {
  choose(): Promise<RepositorySpec | null>;
}

export function createNativeFolderPicker(): FolderPicker {
  return {
    async choose() {
      if (process.platform !== "darwin") {
        throw new Error(
          "The native folder picker is not available on this platform; enter a path instead.",
        );
      }
      try {
        const { stdout } = await execute("osascript", [
          "-e",
          'POSIX path of (choose folder with prompt "Choose a Git repository for hyagent")',
        ]);
        const root = stdout.trim().replace(/\/$/, "");
        return root ? { name: basename(root), root } : null;
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr ?? "";
        if (/User canceled/i.test(stderr)) return null;
        throw error;
      }
    },
  };
}
