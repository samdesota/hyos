import tailwindcss from "@tailwindcss/vite";
import { uiAgent } from "@hyos/ui-agent/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [tailwindcss(), solid(), uiAgent()],
});
