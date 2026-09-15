import { createHash, randomUUID } from "node:crypto";
import {
  getColumnDefinition,
  getIndexDefinition,
  getSchemaDefinition,
  getTableDefinition,
  type AnySchema,
  type AnyTable,
} from "../schema.js";
import type {
  BranchName,
  BranchSequence,
  CommitId,
  RetentionPolicy,
  StorageKey,
  StorageMutation,
} from "../storage.js";
import {
  decodeValue,
  encodeValue,
  encodeOrderedKey,
  keyPrefixUpperBound,
} from "./codec.js";
import { ImmutableBPlusTree, type TreeRoot } from "./bplus-tree.js";
export type StoredRow = Readonly<Record<string, unknown>>;

export function decodeRow(bytes: Uint8Array): StoredRow {
  return Object.freeze(decodeValue(bytes) as Record<string, unknown>);
}

export function cloneRow(row: Readonly<Record<string, unknown>>): StoredRow {
  return decodeRow(encodeValue(row));
}

export type TableManifest = {
  primary: TreeRoot;
  indexes: Record<string, TreeRoot>;
};

export type DatabaseManifest = {
  schema: string;
  tables: Record<string, TableManifest>;
  /**
   * Progress marker written only by migration commits: the number of
   * migration steps already applied to the branch. cloneManifest drops it so
   * ordinary commits never inherit migration progress.
   */
  migration?: { step: number };
};

export type StoredChange = {
  table: string;
  key: StorageKey;
  before?: StoredRow;
  after?: StoredRow;
};

export type StoredCommit = {
  id?: CommitId;
  committedAtMs?: number;
  parent: CommitId | null;
  branch: BranchName;
  sequence: BranchSequence;
  manifest: DatabaseManifest;
  changes: StoredChange[];
};

export const foreverRetention: RetentionPolicy = Object.freeze({
  mode: "forever",
});

export function validateRetention(policy: RetentionPolicy): RetentionPolicy {
  if (policy.mode === "forever") return foreverRetention;
  if (!Number.isSafeInteger(policy.keepAtLeast) || policy.keepAtLeast < 1) {
    throw new TypeError("retention.keepAtLeast must be a positive integer");
  }
  if (
    policy.keepYoungerThanMs !== undefined &&
    (!Number.isFinite(policy.keepYoungerThanMs) ||
      policy.keepYoungerThanMs <= 0)
  ) {
    throw new TypeError("retention.keepYoungerThanMs must be positive");
  }
  return Object.freeze({
    mode: "window",
    keepAtLeast: policy.keepAtLeast,
    ...(policy.keepYoungerThanMs === undefined
      ? {}
      : { keepYoungerThanMs: policy.keepYoungerThanMs }),
  });
}

export function sameRetention(
  left: RetentionPolicy,
  right: RetentionPolicy,
): boolean {
  return (
    left.mode === right.mode &&
    (left.mode === "forever" ||
      (right.mode === "window" &&
        left.keepAtLeast === right.keepAtLeast &&
        left.keepYoungerThanMs === right.keepYoungerThanMs))
  );
}

export type TableMetadata = Readonly<{
  table: AnyTable;
  name: string;
  primaryColumns: readonly string[];
  indexes: readonly Readonly<{
    name: string;
    unique: boolean;
    columns: readonly string[];
  }>[];
}>;

export const newCommitId = (): CommitId => `commit:${randomUUID()}`;

export function cloneManifest(manifest: DatabaseManifest): DatabaseManifest {
  // The migration progress marker is intentionally dropped: only migration
  // commits themselves carry progress, so ordinary commits never inherit it.
  return {
    schema: manifest.schema,
    tables: Object.fromEntries(
      Object.entries(manifest.tables).map(([name, table]) => [
        name,
        { primary: table.primary, indexes: { ...table.indexes } },
      ]),
    ),
  };
}

export function schemaMetadata(
  schema: AnySchema,
  addedNullableColumns: Readonly<Record<string, readonly string[]>> = {},
  omittedTables: readonly string[] = [],
): {
  fingerprint: string;
  tables: ReadonlyMap<string, TableMetadata>;
} {
  const tables = new Map<string, TableMetadata>();
  const description = Object.values(getSchemaDefinition(schema).tables)
    .map((table) => {
      const definition = getTableDefinition(table);
      const columns = Object.entries(definition.columns).map(
        ([name, column]) => {
          const value = getColumnDefinition(column);
          return {
            name,
            dataType: value.dataType,
            notNull: value.notNull,
            primaryKey: value.primaryKey,
          };
        },
      );
      const indexes = definition.indexes.map((value) => {
        const index = getIndexDefinition(value);
        return {
          name: index.name,
          unique: index.unique,
          columns: index.columns.map(
            (column) => getColumnDefinition(column).name,
          ),
        };
      });
      tables.set(definition.name, {
        table,
        name: definition.name,
        primaryColumns: columns
          .filter((column) => column.primaryKey)
          .map((column) => column.name),
        indexes,
      });
      const added = addedNullableColumns[definition.name] ?? [];
      for (const name of added) {
        const column = columns.find((column) => column.name === name);
        if (
          !column ||
          column.notNull ||
          column.primaryKey ||
          indexes.some((index) => index.columns.includes(name))
        ) {
          throw new TypeError(
            `Migration requires a nullable, non-indexed column: ${definition.name}.${name}`,
          );
        }
      }
      return {
        name: definition.name,
        columns: columns.filter((column) => !added.includes(column.name)),
        indexes,
      };
    })
    .filter((table) => !omittedTables.includes(table.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const name of Object.keys(addedNullableColumns)) {
    if (!tables.has(name))
      throw new TypeError(`Unknown migration table: ${name}`);
  }
  return {
    fingerprint: createHash("sha256")
      .update(JSON.stringify(description))
      .digest("hex"),
    tables,
  };
}

export function primaryKey(
  metadata: TableMetadata,
  row: StoredRow,
): StorageKey {
  return metadata.primaryColumns.map((column) => row[column]);
}

export function indexPrefix(
  index: TableMetadata["indexes"][number],
  row: StoredRow,
): StorageKey {
  return index.columns.map((column) => row[column]);
}

export function indexKey(
  index: TableMetadata["indexes"][number],
  row: StoredRow,
  key: StorageKey,
): Uint8Array {
  return encodeOrderedKey([...indexPrefix(index, row), ...key]);
}

export async function applyTreeMutations(
  tree: ImmutableBPlusTree,
  tables: ReadonlyMap<string, TableMetadata>,
  manifest: DatabaseManifest,
  mutations: readonly StorageMutation[],
): Promise<StoredChange[]> {
  const changes: StoredChange[] = [];
  for (const mutation of mutations) {
    const name = getTableDefinition(mutation.table).name;
    const metadata = tables.get(name);
    const table = manifest.tables[name];
    if (metadata === undefined || table === undefined) {
      throw new TypeError(`Unknown table: ${name}`);
    }
    const key =
      mutation.type === "insert"
        ? primaryKey(metadata, mutation.row)
        : mutation.key;
    const encodedKey = encodeOrderedKey(key);
    const beforeBytes = await tree.get(table.primary, encodedKey);
    const before =
      beforeBytes === undefined ? undefined : decodeRow(beforeBytes);
    let after: StoredRow | undefined;

    if (mutation.type === "insert") {
      if (before !== undefined)
        throw new TypeError(`Duplicate primary key for table ${name}`);
      after = cloneRow(mutation.row);
    } else {
      if (before === undefined)
        throw new TypeError(`Missing row for table ${name}`);
      if (mutation.type === "update") {
        if (
          Buffer.compare(
            encodeOrderedKey(primaryKey(metadata, mutation.row)),
            encodedKey,
          ) !== 0
        ) {
          throw new TypeError(
            `Primary keys cannot be updated for table ${name}`,
          );
        }
        after = cloneRow(mutation.row);
      }
    }

    for (const index of metadata.indexes) {
      let root = table.indexes[index.name] ?? null;
      if (before !== undefined) {
        root = await tree.mutate(root, [
          { type: "delete", key: indexKey(index, before, key) },
        ]);
      }
      if (after !== undefined) {
        if (index.unique) {
          const prefix = encodeOrderedKey(indexPrefix(index, after));
          for await (const existing of tree.scan(root, {
            gte: prefix,
            lt: keyPrefixUpperBound(prefix),
            limit: 1,
          })) {
            if (existing !== undefined) {
              throw new TypeError(
                `Unique index ${index.name} rejected a duplicate key`,
              );
            }
          }
        }
        root = await tree.mutate(root, [
          {
            type: "put",
            key: indexKey(index, after, key),
            value: encodeValue(key),
          },
        ]);
      }
      table.indexes[index.name] = root;
    }

    table.primary = await tree.mutate(table.primary, [
      after === undefined
        ? { type: "delete", key: encodedKey }
        : { type: "put", key: encodedKey, value: encodeValue(after) },
    ]);
    changes.push({
      table: name,
      key: [...key],
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    });
  }

  return changes;
}
