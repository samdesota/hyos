import { getTableDefinition, type AnyTable, type InferRow } from "../schema.js";
import type {
  BranchName,
  BranchSequence,
  CommitId,
  StorageKey,
  StorageScan,
  StorageSnapshot,
} from "../storage.js";
import { ImmutableBPlusTree, type TreeRange } from "./bplus-tree.js";
import { decodeValue, encodeOrderedKey, keyPrefixUpperBound } from "./codec.js";
import {
  decodeRow,
  type DatabaseManifest,
  type TableMetadata,
} from "./tree-storage-model.js";
function encodedRange(
  range: StorageScan["range"],
  prefixValues: boolean,
): TreeRange {
  if (range === undefined) return {};
  return {
    ...(range.gt === undefined
      ? {}
      : {
          ...(prefixValues
            ? { gte: keyPrefixUpperBound(encodeOrderedKey(range.gt)) }
            : { gt: encodeOrderedKey(range.gt) }),
        }),
    ...(range.gte === undefined ? {} : { gte: encodeOrderedKey(range.gte) }),
    ...(range.lt === undefined ? {} : { lt: encodeOrderedKey(range.lt) }),
    ...(range.lte === undefined
      ? {}
      : {
          ...(prefixValues
            ? { lt: keyPrefixUpperBound(encodeOrderedKey(range.lte)) }
            : { lte: encodeOrderedKey(range.lte) }),
        }),
    reverse: range.reverse,
    limit: range.limit,
  };
}

export class NodeSnapshot implements StorageSnapshot {
  readonly version: BranchSequence;
  #closed = false;

  constructor(
    readonly commit: CommitId,
    readonly sequence: BranchSequence,
    readonly branch: BranchName | undefined,
    private readonly manifest: DatabaseManifest,
    private readonly tree: ImmutableBPlusTree,
    private readonly tables: ReadonlyMap<string, TableMetadata>,
    private readonly release: () => Promise<void>,
  ) {
    this.version = sequence;
  }

  async get<TableValue extends AnyTable>(
    table: TableValue,
    key: StorageKey,
  ): Promise<InferRow<TableValue> | undefined> {
    this.assertOpen();
    const name = getTableDefinition(table).name;
    const root = this.manifest.tables[name]?.primary;
    if (root === undefined) throw new TypeError(`Unknown table: ${name}`);
    const value = await this.tree.get(root, encodeOrderedKey(key));
    return (value === undefined ? undefined : decodeRow(value)) as
      InferRow<TableValue> | undefined;
  }

  async *scan<TableValue extends AnyTable>(
    request: StorageScan<TableValue>,
  ): AsyncIterable<readonly InferRow<TableValue>[]> {
    this.assertOpen();
    const name = getTableDefinition(request.table).name;
    const table = this.manifest.tables[name];
    const metadata = this.tables.get(name);
    if (table === undefined || metadata === undefined) {
      throw new TypeError(`Unknown table: ${name}`);
    }

    const rows: InferRow<TableValue>[] = [];
    const emit = async function* (): AsyncIterable<
      readonly InferRow<TableValue>[]
    > {
      if (rows.length > 0) {
        yield Object.freeze(rows.splice(0, rows.length));
      }
    };

    if (request.type === "table") {
      for await (const entry of this.tree.scan(
        table.primary,
        encodedRange(request.range, false),
      )) {
        rows.push(decodeRow(entry.value) as InferRow<TableValue>);
        if (rows.length === 1_024) yield* emit();
      }
    } else {
      const index = metadata.indexes.find(
        (value) => value.name === request.index,
      );
      if (index === undefined)
        throw new TypeError(`Unknown index: ${request.index}`);
      const root = table.indexes[index.name];
      const range =
        request.key === undefined
          ? encodedRange(request.range, true)
          : {
              gte: encodeOrderedKey(request.key),
              lt: keyPrefixUpperBound(encodeOrderedKey(request.key)),
              reverse: request.range?.reverse,
              limit: request.range?.limit,
            };
      for await (const entry of this.tree.scan(root, range)) {
        const key = decodeValue(entry.value) as StorageKey;
        const value = await this.tree.get(table.primary, encodeOrderedKey(key));
        if (value !== undefined)
          rows.push(decodeRow(value) as InferRow<TableValue>);
        if (rows.length === 1_024) yield* emit();
      }
    }
    yield* emit();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.release();
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("Storage snapshot is closed");
  }
}
