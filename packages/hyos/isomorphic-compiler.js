const fs = require("node:fs");
const path = require("node:path");
const { build } = require("esbuild");
const { solidPlugin } = require("esbuild-plugin-solid");

function compiledRendererFilename(sourceFile) {
  return `${path.basename(sourceFile, path.extname(sourceFile))}.js`;
}

async function buildRendererArtifacts({
  manifest,
  manifestPath,
  projectDirectory,
  capabilitiesPath,
  outputDirectory,
}) {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  await Promise.all([
    build({
      entryPoints: [manifestPath],
      outfile: path.join(outputDirectory, "application-manifest.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
    }),
    build({
      entryPoints: [capabilitiesPath],
      outfile: path.join(outputDirectory, "capabilities.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
    }),
  ]);

  const rendererEntries = manifest.modules.filter(
    ({ host }) => host === "renderer",
  );
  const entryPoints = Object.fromEntries(
    rendererEntries.map((entry) => [
      path.basename(compiledRendererFilename(entry.file), ".js"),
      path.resolve(projectDirectory, entry.file),
    ]),
  );
  await build({
    entryPoints,
    outdir: outputDirectory,
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    splitting: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    plugins: [solidPlugin()],
  });
}

module.exports = { buildRendererArtifacts, compiledRendererFilename };
