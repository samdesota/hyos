import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let html2canvasSource: string | undefined;

export function renderHtml2CanvasScript(): string {
  html2canvasSource ??= readFileSync(
    fileURLToPath(import.meta.resolve("html2canvas/dist/html2canvas.esm.js")),
    "utf8",
  );
  return html2canvasSource;
}
