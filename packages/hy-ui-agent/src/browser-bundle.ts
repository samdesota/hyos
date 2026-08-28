import { fileURLToPath } from "node:url";

import { build } from "esbuild";

let activityClientBundle: Promise<string> | undefined;

export function renderActivityClientScript(): Promise<string> {
  activityClientBundle ??= build({
    entryPoints: [
      fileURLToPath(new URL("./browser-activity-client.js", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    minify: true,
  }).then((result) => result.outputFiles[0]?.text ?? "");
  return activityClientBundle;
}
