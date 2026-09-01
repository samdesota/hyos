import { spawn } from "node:child_process";

import { chooseDevPorts } from "./dev-ports.js";

const host = process.env.HOST ?? "127.0.0.1";
const ports = await chooseDevPorts({
  host,
  serverPort: Number(process.env.HYAGENT_PORT ?? 4328),
  clientPort: Number(process.env.HYAGENT_CLIENT_PORT ?? 5184),
});
const environment = {
  ...process.env,
  HYAGENT_PORT: String(ports.server),
  HYAGENT_CLIENT_PORT: String(ports.client),
};

console.log(`Starting hyagent at http://${host}:${ports.client}/`);
console.log(`API server: http://${host}:${ports.server}`);

const npmCli = process.env.npm_execpath;
const child = npmCli
  ? spawn(process.execPath, [npmCli, "run", "dev:services"], {
      env: environment,
      stdio: "inherit",
    })
  : spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "dev:services"],
      {
        env: environment,
        stdio: "inherit",
      },
    );

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => child.kill(signal));
}

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    resolve(code ?? (signal ? 1 : 0));
  });
});
process.exitCode = exitCode;
