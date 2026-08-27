import { defineConfig } from "vite";

import { uiAgent } from "../src/vite.js";

export default defineConfig({
  plugins: [uiAgent()],
});
