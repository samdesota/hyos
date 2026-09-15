import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const output = resolve(process.argv[2] ?? "benchmarks/results/storage.json");
const repetitions = Number(process.env.HYDB_BENCH_REPEATS ?? 3);
if (!Number.isSafeInteger(repetitions) || repetitions < 1)
  throw new Error("HYDB_BENCH_REPEATS must be positive");
const worker = fileURLToPath(new URL("./storage-worker.mjs", import.meta.url));
const storageCommit = (
  await promisify(execFile)("git", ["rev-parse", "HEAD"], {
    cwd: dirname(worker),
  })
).stdout.trim();
const result = {
  storageCommit,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: platform(),
    osRelease: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramBytes: totalmem(),
    lmdb: "3.5.6",
  },
  repetitions,
  runs: [],
};
await mkdir(dirname(output), { recursive: true });
for (let round = 0; round < repetitions; round++) {
  for (const size of ["small", "large"]) {
    // Alternate order to reduce systematic filesystem/cache/order bias.
    for (const engine of round % 2 ? ["lmdb", "file"] : ["file", "lmdb"]) {
      console.log(`Round ${round + 1}/${repetitions}: ${engine}/${size}`);
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [worker, engine, size],
        { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      );
      process.stdout.write(stderr);
      result.runs.push({ round: round + 1, ...JSON.parse(stdout) });
      await writeFile(output, JSON.stringify(result, null, 2) + "\n");
    }
  }
}
console.log(`Results: ${output}`);
