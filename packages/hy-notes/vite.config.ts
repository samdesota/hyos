import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { compileCommandModule } from "@hyos/hyapp/compiler";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [
    tailwindcss(),
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
      "@hyos/components": fileURLToPath(
        new URL("../hyos-components/src/index.ts", import.meta.url),
      ),
      "@hyos/hyapp/solid": fileURLToPath(
        new URL("../hyapp/src/solid.ts", import.meta.url),
      ),
      "@hyos/hyapp/http": fileURLToPath(
        new URL("../hyapp/src/http.ts", import.meta.url),
      ),
      "@hyos/hyapp": fileURLToPath(
        new URL("../hyapp/src/index.ts", import.meta.url),
      ),
      "@hyos/hydb": fileURLToPath(
        new URL("../hydb/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3001",
    },
  },
});
