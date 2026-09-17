import { stat } from "node:fs/promises";
import path from "node:path";
import {
  openKeyValueStorage,
  openLmdbKeyValueStore,
  openNodeStorage,
} from "@hyos/hydb/node";
import { agentMigrations } from "./migrations/index.js";
import { agentSchema } from "./model.js";

export type AgentStorageBackend = "file" | "lmdb";
const retention = {
  mode: "window",
  keepAtLeast: 200,
  keepYoungerThanMs: 86_400_000,
} as const;

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Media/preferences stay in directory; LMDB owns only its lmdb/ child. */
export async function openAgentStorage(
  directory: string,
  backend: AgentStorageBackend,
) {
  if (backend === "file")
    return openNodeStorage({
      directory,
      schema: agentSchema,
      migrations: agentMigrations,
      retention,
    });
  if (backend !== "lmdb")
    throw new Error(`Unknown agent storage backend: ${backend}`);
  const legacyExists = await exists(path.join(directory, "hydb.data"));
  const lmdbDirectory = path.join(directory, "lmdb");
  const importRequired = () =>
    new Error(
      "Agent database needs a verified file-to-LMDB import before startup",
    );
  if (legacyExists && !(await exists(path.join(lmdbDirectory, "data.mdb"))))
    throw importRequired();
  const store = openLmdbKeyValueStore(lmdbDirectory);
  try {
    // Never show an empty session list when an existing file database has not
    // been imported successfully. Initialization is allowed on fresh installs.
    if (legacyExists && !(await store.get("metadata"))) throw importRequired();
    return await openKeyValueStorage({ store, schema: agentSchema, retention });
  } catch (error) {
    await store.close();
    throw error;
  }
}
