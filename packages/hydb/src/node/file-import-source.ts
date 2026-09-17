import { decodeValue } from "./codec.js";
import { AppendOnlyPageStore } from "./page-store.js";
import {
  foreverRetention,
  validateRetention,
  type StoredCommit,
} from "./tree-storage-model.js";
import type { Branch } from "./key-value-layout.js";
import type { RetentionPolicy } from "../storage.js";

/** Replay publication refs, ignoring orphan commits exactly as the file engine does. */
export async function readImportCatalog(store: AppendOnlyPageStore) {
  const commits = new Map<string, number>();
  const published = new Set<string>();
  const branches = new Map<string, Branch>();
  const history = new Map<
    string,
    { branch: string; sequence: number; id: string }
  >();
  let retention: RetentionPolicy = foreverRetention;
  let retains: Record<string, string> = {};
  let floors: Record<string, number> = {};
  for await (const record of store.records(
    new Set(["commit", "ref", "meta"]),
  )) {
    const value = decodeValue(record.payload);
    if (record.type === "commit") {
      const commit = value as StoredCommit;
      commits.set(commit.id ?? `commit:${record.id}`, record.id);
    } else if (record.type === "meta") {
      const meta = value as {
        format: number;
        retention: RetentionPolicy;
        retains?: Record<string, string>;
        historyFloors?: Record<string, number>;
      };
      if (meta.format !== 2) throw new Error("Unsupported source format");
      retention = validateRetention(meta.retention);
      retains = meta.retains ?? {};
      floors = meta.historyFloors ?? {};
    } else {
      const ref = value as {
        operation: string;
        branch: string;
        head: string;
        sequence: number;
      };
      if (ref.operation !== "create" && ref.operation !== "commit")
        throw new Error("Invalid source publication");
      published.add(ref.head);
      const prior = branches.get(ref.branch);
      branches.set(ref.branch, {
        head: ref.head,
        sequence: ref.sequence,
        base: ref.operation === "create" ? ref.head : (prior?.base ?? ref.head),
      });
      if (ref.operation === "commit")
        history.set(JSON.stringify([ref.branch, ref.sequence]), {
          branch: ref.branch,
          sequence: ref.sequence,
          id: ref.head,
        });
    }
  }
  for (const id of commits.keys()) if (!published.has(id)) commits.delete(id);
  for (const id of published)
    if (!commits.has(id)) throw new Error(`Missing published commit ${id}`);
  if (!branches.has("main")) throw new Error("Source has no main branch");
  for (const [name, branch] of branches) branch.floor = floors[name] ?? 0;
  for (const id of Object.values(retains))
    if (!commits.has(id)) throw new Error("Missing retained commit");
  return { commits, branches, history, retention, retains };
}
