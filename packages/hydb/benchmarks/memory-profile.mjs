import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";

export async function createMemoryProfile(directory) {
  await mkdir(directory, { recursive: true });
  const checkpoints = [],
    peaks = {};
  let phase = "open";
  const sample = (memory = process.memoryUsage()) => {
    const peak = (peaks[phase] ??= {});
    for (const [key, value] of Object.entries(memory))
      peak[key] = Math.max(peak[key] ?? 0, value);
  };
  return {
    sample,
    phase(name) {
      phase = name;
      sample();
    },
    async checkpoint(label, vm = true) {
      sample();
      const memory = process.memoryUsage();
      const row = {
        label,
        memory,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      };
      if (vm && process.platform === "darwin") {
        try {
          const { stdout } = await promisify(execFile)(
            "/usr/bin/vmmap",
            ["-summary", String(process.pid)],
            { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
          );
          row.vmmap = stdout;
        } catch (error) {
          row.vmmapError = String(error);
        }
      }
      checkpoints.push(row);
      await writeFile(
        join(directory, "profile.json"),
        JSON.stringify({ checkpoints, peaks }, null, 2) + "\n",
      );
    },
    async collectJsGarbage(label) {
      if (!global.gc) throw new Error("Run memory profiling with --expose-gc");
      for (let i = 0; i < 3; i++) {
        global.gc();
        await setImmediate();
      }
      await this.checkpoint(label);
    },
  };
}
