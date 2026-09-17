#!/usr/bin/env node
import { resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { importFileStorage } = require("../dist-cjs/src/node/index.js");

const args = process.argv.slice(2);
if (args.length !== 3) {
  console.error(
    "Usage: node --import tsx packages/hydb/scripts/import-file.mjs SOURCE_FILE NEW_DESTINATION SCHEMA_MODULE#EXPORT",
  );
  process.exitCode = 2;
} else {
  const [sourceFile, destinationDirectory, spec] = args;
  const [file, name = "default"] = spec.split("#");
  const schema = require(resolve(file))[name];
  if (!schema) throw new Error(`Missing schema export ${name}`);
  const report = await importFileStorage({
    sourceFile,
    destinationDirectory,
    schema,
    onProgress: (phase, count) => console.error(`${phase}: ${count}`),
  });
  console.log(
    JSON.stringify(
      {
        destination: resolve(destinationDirectory),
        pages: report.pages,
        commits: report.commits,
        branches: report.branches,
        queries: report.queries.reduce((n, b) => n + b.results.length, 0),
        verified: true,
      },
      null,
      2,
    ),
  );
}
