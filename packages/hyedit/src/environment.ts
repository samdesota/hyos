import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

export function loadNearestHyeditEnvironment(
  start: string,
): Record<string, string | undefined> {
  let directory = resolve(start);
  while (true) {
    const file = join(directory, ".env");
    if (existsSync(file)) return parseEnv(readFileSync(file, "utf8"));
    const parent = dirname(directory);
    if (parent === directory) return {};
    directory = parent;
  }
}
