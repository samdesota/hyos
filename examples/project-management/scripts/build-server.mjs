import { resolve } from "node:path";

import { build } from "esbuild";

const exampleDirectory = resolve(import.meta.dirname, "..");

await build({
  entryPoints: [resolve(exampleDirectory, "src/server.ts")],
  outfile: resolve(exampleDirectory, "dist/server/server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  alias: {
    "@hyos/hyapp/http": resolve(
      exampleDirectory,
      "../../packages/hyapp/src/http.ts",
    ),
    "@hyos/hyapp/node": resolve(
      exampleDirectory,
      "../../packages/hyapp/src/node/index.ts",
    ),
    "@hyos/hyapp/wire": resolve(
      exampleDirectory,
      "../../packages/hyapp/src/wire.ts",
    ),
    "@hyos/hyapp": resolve(
      exampleDirectory,
      "../../packages/hyapp/src/index.ts",
    ),
    "@hyos/hydb": resolve(exampleDirectory, "../../packages/hydb/src/index.ts"),
    "@hyos/hydb/node": resolve(
      exampleDirectory,
      "../../packages/hydb/src/node/index.ts",
    ),
  },
});
