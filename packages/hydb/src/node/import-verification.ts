import { createHash } from "node:crypto";
import type { StorageSnapshot, StorageScan } from "../storage.js";
import type { TableMetadata } from "./tree-storage-model.js";
import { encodeValue } from "./codec.js";

export type ImportQueryResult = Readonly<{
  query: string;
  rows: number;
  sha256: string;
}>;

/** Streaming full-content checks plus point/range/prefix queries chosen from actual rows.
 * Reports contain hashes and counts, never row contents or query parameter values. */
export async function fingerprintImportQueries(
  snapshot: StorageSnapshot,
  tables: ReadonlyMap<string, TableMetadata>,
  onQuery?: (query: string, rows: number) => void,
): Promise<ImportQueryResult[]> {
  const results: ImportQueryResult[] = [];
  const digest = async (query: string, request: StorageScan) => {
    const hash = createHash("sha256");
    let rows = 0;
    for await (const batch of snapshot.scan(request))
      for (const row of batch) {
        const bytes = encodeValue(row);
        hash.update(String(bytes.length)).update(":").update(bytes);
        rows++;
      }
    results.push({ query, rows, sha256: hash.digest("hex") });
    onQuery?.(query, rows);
  };
  for (const table of tables.values()) {
    await digest(`${table.name}:all`, { type: "table", table: table.table });
    await digest(`${table.name}:reverse-limit`, {
      type: "table",
      table: table.table,
      range: { reverse: true, limit: 17 },
    });
    const samples: Readonly<Record<string, unknown>>[] = [];
    for await (const batch of snapshot.scan({
      type: "table",
      table: table.table,
      range: { limit: 3 },
    }))
      samples.push(...batch);
    for (const [i, row] of samples.entries()) {
      const key = table.primaryColumns.map((column) => row[column]);
      const found = await snapshot.get(table.table, key);
      if (found === undefined)
        throw new Error(`Point lookup missing in ${table.name}`);
      results.push({
        query: `${table.name}:point:${i}`,
        rows: 1,
        sha256: createHash("sha256").update(encodeValue(found)).digest("hex"),
      });
      await digest(`${table.name}:range:${i}`, {
        type: "table",
        table: table.table,
        range: { gte: key, limit: 11 },
      });
    }
    for (const index of table.indexes) {
      await digest(`${table.name}:${index.name}:all`, {
        type: "index",
        table: table.table,
        index: index.name,
      });
      for (const [i, row] of samples.entries())
        await digest(`${table.name}:${index.name}:prefix:${i}`, {
          type: "index",
          table: table.table,
          index: index.name,
          key: [row[index.columns[0]!]],
        });
    }
  }
  return results;
}
