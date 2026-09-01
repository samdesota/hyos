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
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.HYAGENT_CLIENT_PORT ?? 5184),
    strictPort: true,
    proxy: {
      "/trpc": {
        target: `http://127.0.0.1:${process.env.HYAGENT_PORT ?? "4328"}`,
        ws: true,
      },
    },
  },
});
