import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Loader, Plugin } from "esbuild";

import {
  compileCommandModule,
  type CommandCompilationTarget,
} from "./compiler.js";

function loaderFor(path: string): Loader {
  switch (extname(path)) {
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    default:
      return "ts";
  }
}

export function hyappCommandsPlugin(options: {
  target: CommandCompilationTarget;
}): Plugin {
  return {
    name: "hyapp-commands",
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        if (args.path.includes("/node_modules/")) return undefined;
        const source = await readFile(args.path, "utf8");
        const compiled = compileCommandModule(source, {
          target: options.target,
          filename: args.path,
        });
        const sourceMap =
          compiled.map === null
            ? ""
            : `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(
                JSON.stringify(compiled.map),
              ).toString("base64")}`;
        return {
          contents: `${compiled.code}${sourceMap}`,
          loader: loaderFor(args.path),
        };
      });
    },
  };
}
