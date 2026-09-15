import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

async function executableFile(candidate: string): Promise<string | null> {
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

export async function resolveExecutable(
  command: string,
): Promise<string | null> {
  if (command.includes(path.sep) || path.isAbsolute(command)) {
    return executableFile(path.resolve(command));
  }
  const directories = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const found = await executableFile(
        path.join(directory, command + extension),
      );
      if (found) return found;
    }
  }
  return null;
}
