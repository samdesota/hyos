import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "@hyos/hydb": fileURLToPath(
        new URL("../../packages/hydb/src/index.ts", import.meta.url),
      ),
    },
  },
});
