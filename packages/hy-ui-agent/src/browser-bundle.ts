import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

interface BrowserAssets {
  host: string;
  overlayScript: string;
  overlayStyles: string;
}

let browserAssets: Promise<BrowserAssets> | undefined;
let assetsBuiltAt = 0;

function packageRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = dirname(moduleDirectory);
  return sourceRoot.endsWith(join("dist")) ? dirname(sourceRoot) : sourceRoot;
}

function sourceEntry(name: string): string {
  const extension = name === "overlay-entry" ? "tsx" : "ts";
  const entry = join(packageRoot(), "src", "browser", `${name}.${extension}`);
  if (!existsSync(entry))
    throw new Error(`Browser entry point not found: ${entry}`);
  return entry;
}

async function buildBrowserAssets(): Promise<BrowserAssets> {
  const [hostResult, overlayResult] = await Promise.all([
    build({
      entryPoints: [sourceEntry("host-entry")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      minify: true,
    }),
    build({
      entryPoints: [sourceEntry("overlay-entry")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      minify: true,
      outdir: "browser-assets",
    }),
  ]);
  const overlayScript = overlayResult.outputFiles.find((file) =>
    file.path.endsWith(".js"),
  );
  const overlayStyles = overlayResult.outputFiles.find((file) =>
    file.path.endsWith(".css"),
  );
  return {
    host: hostResult.outputFiles[0]?.text ?? "",
    overlayScript: overlayScript?.text ?? "",
    overlayStyles: overlayStyles?.text ?? "",
  };
}

function assets(): Promise<BrowserAssets> {
  if (!browserAssets || Date.now() - assetsBuiltAt > 1_000) {
    assetsBuiltAt = Date.now();
    browserAssets = buildBrowserAssets();
  }
  return browserAssets;
}

export async function renderHostClientScript(): Promise<string> {
  return (await assets()).host;
}

export async function renderOverlayScript(): Promise<string> {
  return (await assets()).overlayScript;
}

export async function renderOverlayStyles(): Promise<string> {
  return (await assets()).overlayStyles;
}
