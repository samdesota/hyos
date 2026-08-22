import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { compileCommandModule } from "@hyos/hyapp/compiler";

export default defineConfig({
  plugins: [
    {
      name: "hyapp-client-commands",
      enforce: "pre",
      transform(source, id) {
        if (!/\.[cm]?[jt]sx?$/.test(id) || id.includes("/node_modules/")) {
          return undefined;
        }
        return compileCommandModule(source, {
          target: "client",
          filename: id,
        }).code;
      },
    },
    solid(),
  ],
  resolve: {
    alias: {
      "@hyos/hyapp": fileURLToPath(
        new URL("../../packages/hyapp/src/index.ts", import.meta.url),
      ),
      "@hyos/hydb": fileURLToPath(
        new URL("../../packages/hydb/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3001",
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
