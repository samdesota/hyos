#!/usr/bin/env node
// hydb migration tooling: diff two schema modules, check that a declared
// migration chain covers the schema change, and generate the next migration
// file from a diff.
//
// Usage (run from packages/hydb, or via `npm run migration -- <args>`):
//   node scripts/migration-cli.mjs check --schema <file[#export]> --migrations <file[#export]>
//   node scripts/migration-cli.mjs diff --from <file[#export]> --to <file[#export]>
//   node scripts/migration-cli.mjs generate --id <id> --from <file[#export]> --to <file[#export]> [--out <file>] [--force]
//
// Modules are loaded with a plain dynamic import; point the loader at
// compiled JavaScript, or run the CLI through a TypeScript loader such as
// `node --import tsx scripts/migration-cli.mjs ...`.
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const hydb = require("../dist/src/node/index.js");

function usage() {
  console.error(`Usage:
  migration-cli check --schema <file[#export]> --migrations <file[#export]> [--base <file[#export]>]
  migration-cli diff --from <file[#export]> --to <file[#export]>
  migration-cli generate --id <id> --from <file[#export]> --to <file[#export]> [--out <file>] [--force]`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const args = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) usage();
    const name = token.slice(2);
    if (name === "force") {
      flags.add(name);
      continue;
    }
    const value = argv[++index];
    if (value === undefined) usage();
    args[name] = value;
  }
  return { args, flags };
}

/** Loads `path#exportName` (default export when no fragment is given). */
async function loadModule(spec) {
  const hash = spec.indexOf("#");
  const path = resolve(hash === -1 ? spec : spec.slice(0, hash));
  const name = hash === -1 ? "default" : spec.slice(hash + 1) || "default";
  const module = await import(`${pathToFileURL(path).href}`);
  const value = module[name];
  if (value === undefined) {
    throw new Error(`Module ${path} does not export ${name}`);
  }
  return value;
}

function describeOp(op) {
  if (op.type === "addTable" || op.type === "dropTable") {
    return `${op.type} ${op.description.name}`;
  }
  return `${op.type} ${op.table}.${op.column.name}`;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "check") {
    const { args } = parseArgs(rest);
    if (args.schema === undefined || args.migrations === undefined) usage();
    const schema = await loadModule(args.schema);
    const migrations = await loadModule(args.migrations);
    if (!Array.isArray(migrations)) {
      throw new TypeError("--migrations must export a migration array");
    }
    const base = args.base === undefined ? undefined : await loadModule(args.base);
    const check = hydb.checkMigrationChain(schema, migrations, base);
    if (check.error !== undefined) {
      console.error(`invalid migration chain: ${check.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`base:   ${check.baseFingerprint}`);
    console.log(`target: ${check.targetFingerprint}`);
    for (const issue of check.issues) {
      for (const op of issue.missing) {
        console.error(`missing  [${issue.migrationId}] ${describeOp(op)}`);
      }
      for (const op of issue.extra) {
        console.warn(`extra    [${issue.migrationId}] ${describeOp(op)}`);
      }
    }
    if (!check.ok) {
      console.error("migration chain does not cover the schema change");
      process.exitCode = 1;
      return;
    }
    console.log("migration chain covers the schema change");
    return;
  }
  if (command === "diff" || command === "generate") {
    const { args, flags } = parseArgs(rest);
    if (args.from === undefined || args.to === undefined) usage();
    if (command === "generate" && args.id === undefined) usage();
    const from = hydb.describeSchema(await loadModule(args.from));
    const to = hydb.describeSchema(await loadModule(args.to));
    const ops = hydb.diffSchemaDescriptions(from, to);
    if (ops.length === 0) {
      console.log("schemas are identical; no migration needed");
      return;
    }
    for (const op of ops) console.log(describeOp(op));
    const source = hydb.formatMigrationSource(
      command === "generate" ? args.id : "0000-example",
      ops,
    );
    if (command === "diff") {
      console.log("\n" + source);
      return;
    }
    const out = resolve(
      args.out ??
        `${dirname(resolve(args.to.split("#")[0] ?? "."))}/${args.id}.ts`,
    );
    if (existsSync(out) && !flags.has("force")) {
      throw new Error(`Refusing to overwrite ${out}; pass --force`);
    }
    writeFileSync(out, source);
    console.log(`\nwrote ${out}`);
    return;
  }
  usage();
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
