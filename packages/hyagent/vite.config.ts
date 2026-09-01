import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "@hyos/hydb": fileURLToPath(
        new URL("../hydb/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5184,
    proxy: {
      "/trpc": {
        target: `http://127.0.0.1:${process.env.HYAGENT_PORT ?? "4328"}`,
        ws: true,
      },
    },
  },
});
