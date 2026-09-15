import type { RetentionPolicy, CommitBatch } from "../storage.js";
import type { KeyValueOperation } from "./key-value-store.js";
import { encodeValue } from "./codec.js";

export type Branch = {
  head: string;
  base: string;
  sequence: number;
  floor?: number;
};
export type Metadata = {
  format: "hydb-kv-1";
  schema: string;
  nextPageId: number;
  revision: number;
  retention: RetentionPolicy;
};
export type Subscriber = {
  branch: string;
  after: number;
  retainAfter: number;
  queue: CommitBatch[];
  wake?: () => void;
};
export const metadataKey = "metadata";
export const commitKey = (id: string) => `commit/${id}`;
export const branchKey = (name: string) => `branch/${encodeURIComponent(name)}`;
export const historyPrefix = (name: string) =>
  `history/${encodeURIComponent(name)}/`;
export const historyKey = (name: string, sequence: number) =>
  `${historyPrefix(name)}${sequence.toString().padStart(16, "0")}`;
export const retainKey = (name: string) => `retain/${encodeURIComponent(name)}`;
export const put = (key: string, value: unknown): KeyValueOperation => ({
  type: "put",
  key,
  value: encodeValue(value),
});
