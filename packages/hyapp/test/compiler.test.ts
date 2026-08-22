import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

import { compileCommandModule } from "../src/compiler.js";
import { hyappCommandsPlugin } from "../src/esbuild.js";
import { hyapp } from "../src/index.js";

const source = `
  import { commandFactory } from "@hyos/hyapp";
  import { principal } from "./principal.js";
  import { policies } from "./policies.js";
  import { serverSecret } from "./server-secret.js";
  import { sharedValue } from "./shared.js";

  function serverHelper() {
    return serverSecret;
  }

  const commands = commandFactory({
    principal,
    defaultPolicy: policies,
  });

  export const update = commands.define({
    input,
    output,
    async optimistic() {
      consume(sharedValue);
    },
    async server() {
      return serverHelper();
    },
  });
`;

test("the hyapp namespace exposes both compiler-target factories", () => {
  assert.equal(typeof hyapp.createClientCommandFactory, "function");
  assert.equal(typeof hyapp.createServerCommandFactory, "function");
});

test("client compilation removes the server dependency graph", () => {
  const compiled = compileCommandModule(source, {
    target: "client",
    filename: "commands.ts",
  });

  assert.match(compiled.code, /createClientCommandFactory/);
  assert.match(compiled.code, /optimistic/);
  assert.match(compiled.code, /sharedValue/);
  assert.doesNotMatch(compiled.code, /serverSecret/);
  assert.doesNotMatch(compiled.code, /serverHelper/);
  assert.doesNotMatch(compiled.code, /\.\/principal/);
  assert.doesNotMatch(compiled.code, /\.\/policies/);
  assert.doesNotMatch(compiled.code, /async server/);
});

test("server compilation retains authoritative behavior and policies", () => {
  const compiled = compileCommandModule(source, {
    target: "server",
    filename: "commands.ts",
  });

  assert.match(compiled.code, /createServerCommandFactory/);
  assert.match(compiled.code, /serverSecret/);
  assert.match(compiled.code, /serverHelper/);
  assert.match(compiled.code, /defaultPolicy/);
  assert.match(compiled.code, /async server/);
});

test("client compilation fails closed on opaque command definitions", () => {
  assert.throws(
    () =>
      compileCommandModule(
        `
          import { commandFactory } from "@hyos/hyapp";
          const commands = commandFactory({ principal, defaultPolicy });
          commands.define({ input, output, ...implementation });
        `,
        { target: "client", filename: "opaque.ts" },
      ),
    /cannot use spreads or computed properties/,
  );

  assert.throws(
    () =>
      compileCommandModule(
        `
          import { commandFactory } from "@hyos/hyapp";
          const commands = commandFactory({ principal, defaultPolicy });
          commands.define(definition);
        `,
        { target: "client", filename: "indirect.ts" },
      ),
    /inline object/,
  );
});

test("the esbuild adapter strips server modules before resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hyapp-esbuild-"));
  const entry = join(directory, "command.ts");
  await writeFile(entry, source, "utf8");
  await writeFile(
    join(directory, "shared.js"),
    "export const sharedValue = 'shared';",
    "utf8",
  );

  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      external: ["@hyos/hyapp"],
      format: "esm",
      platform: "browser",
      plugins: [hyappCommandsPlugin({ target: "client" })],
      write: false,
    });
    const output = result.outputFiles[0]?.text ?? "";
    assert.match(output, /createClientCommandFactory/);
    assert.doesNotMatch(output, /server-secret/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
