import { resolve } from "node:path";

import { hydb } from "@hyos/hydb";
import { openNodeStorage } from "@hyos/hydb/node";

import { hyagentSchema } from "./model.js";
import { createHyagentStore } from "./store.js";

const dataDirectory = resolve(
  process.env.HYAGENT_DATA_DIR ?? ".data/hyagent-prototype-v2",
);
const storage = await openNodeStorage({
  directory: dataDirectory,
  schema: hyagentSchema,
});
const database = await hydb.database({ schema: hyagentSchema, storage });

try {
  const count = await createHyagentStore(database).migrateLegacyRevisions();
  console.log(`Migrated ${count} legacy literate diff revisions`);
} finally {
  await database.close();
}
