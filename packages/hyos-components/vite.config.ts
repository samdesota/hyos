import tailwindcss from "@tailwindcss/vite";
import { hyedit } from "@hyos/hyedit/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [tailwindcss(), solid(), hyedit()],
});
