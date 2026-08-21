import { ByteLruCache, type PageCacheStats } from "./page-cache.js";
import { AppendOnlyPageStore, type RecordId } from "./page-store.js";

export type TreeRoot = RecordId | null;

export type TreeMutation =
  | Readonly<{ type: "put"; key: Uint8Array; value: Uint8Array }>
  | Readonly<{ type: "delete"; key: Uint8Array }>;

export type TreeRange = Readonly<{
  gt?: Uint8Array;
  gte?: Uint8Array;
  lt?: Uint8Array;
  lte?: Uint8Array;
  reverse?: boolean;
  limit?: number;
}>;

export type TreeEntry = Readonly<{
  key: Uint8Array;
  value: Uint8Array;
}>;

type EncodedEntry = { key: string; value: string };
type LeafPage = { kind: "leaf"; entries: EncodedEntry[] };
type InternalPage = { kind: "internal"; keys: string[]; children: RecordId[] };
type Page = LeafPage | InternalPage;

type InsertResult = Readonly<{
  page: RecordId;
  split?: Readonly<{ separator: Uint8Array; right: RecordId }>;
}>;

type DeleteResult = Readonly<{
  page: RecordId;
  changed: boolean;
  underflow: boolean;
  firstKey?: Uint8Array;
}>;

const compare = (left: Uint8Array, right: Uint8Array): number =>
  Buffer.compare(left, right);
const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");
const fromBase64 = (value: string): Uint8Array => Buffer.from(value, "base64");

function lowerBound(entries: readonly EncodedEntry[], key: Uint8Array): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(fromBase64(entries[middle]!.key), key) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function childIndex(keys: readonly string[], key: Uint8Array): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(key, fromBase64(keys[middle]!)) >= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function inRange(key: Uint8Array, range: TreeRange): boolean {
  if (range.gt !== undefined && compare(key, range.gt) <= 0) return false;
  if (range.gte !== undefined && compare(key, range.gte) < 0) return false;
  if (range.lt !== undefined && compare(key, range.lt) >= 0) return false;
  if (range.lte !== undefined && compare(key, range.lte) > 0) return false;
  return true;
}

export class ImmutableBPlusTree {
  readonly #cache: ByteLruCache<RecordId, Page>;

  constructor(
    private readonly store: AppendOnlyPageStore,
    options: { cacheBytes?: number; maxEntries?: number } = {},
  ) {
    this.maxEntries = options.maxEntries ?? 64;
    if (this.maxEntries < 4)
      throw new TypeError("maxEntries must be at least 4");
    this.#cache = new ByteLruCache(
      options.cacheBytes ?? 16 * 1024 * 1024,
      async (id) =>
        this.decodePage((await this.store.read(id, "page")).payload),
      // Decoded strings, arrays, and object headers occupy more heap than
      // their serialized bytes. Keep accounting deliberately conservative.
      (page) => Buffer.byteLength(JSON.stringify(page)) * 2 + 128,
    );
  }

  readonly maxEntries: number;

  cacheStats(): PageCacheStats {
    return this.#cache.stats();
  }

  reclaimCache(bytes: number): number {
    return this.#cache.reclaim(bytes);
  }

  setCacheLimit(bytes: number): void {
    this.#cache.setMaxBytes(bytes);
  }

  async get(root: TreeRoot, key: Uint8Array): Promise<Uint8Array | undefined> {
    let current = root;
    while (current !== null) {
      const page = await this.#cache.get(current);
      if (page.kind === "internal") {
        current = page.children[childIndex(page.keys, key)]!;
        continue;
      }
      const position = lowerBound(page.entries, key);
      const entry = page.entries[position];
      return entry !== undefined && compare(fromBase64(entry.key), key) === 0
        ? fromBase64(entry.value)
        : undefined;
    }
    return undefined;
  }

  async mutate(
    root: TreeRoot,
    mutations: readonly TreeMutation[],
  ): Promise<TreeRoot> {
    let current = root;
    for (const mutation of mutations) {
      if (mutation.type === "put") {
        const result = await this.insert(current, mutation.key, mutation.value);
        if (result.split === undefined) current = result.page;
        else {
          current = await this.writePage({
            kind: "internal",
            keys: [toBase64(result.split.separator)],
            children: [result.page, result.split.right],
          });
        }
      } else if (current !== null) {
        const removed = await this.remove(current, mutation.key, true);
        if (removed.changed) {
          const page = await this.#cache.get(removed.page);
          if (page.kind === "leaf" && page.entries.length === 0) current = null;
          else if (page.kind === "internal" && page.children.length === 1) {
            current = page.children[0]!;
          } else current = removed.page;
        }
      }
    }
    return current;
  }

  async *scan(root: TreeRoot, range: TreeRange = {}): AsyncIterable<TreeEntry> {
    if (root === null || range.limit === 0) return;
    let emitted = 0;
    for await (const entry of this.walk(root, range.reverse === true)) {
      if (!inRange(entry.key, range)) continue;
      yield entry;
      emitted += 1;
      if (range.limit !== undefined && emitted >= range.limit) return;
    }
  }

  private async insert(
    id: TreeRoot,
    key: Uint8Array,
    value: Uint8Array,
  ): Promise<InsertResult> {
    if (id === null) {
      return {
        page: await this.writePage({
          kind: "leaf",
          entries: [{ key: toBase64(key), value: toBase64(value) }],
        }),
      };
    }
    const page = await this.#cache.get(id);
    if (page.kind === "leaf") {
      const entries = [...page.entries];
      const position = lowerBound(entries, key);
      const encoded = { key: toBase64(key), value: toBase64(value) };
      if (
        entries[position] !== undefined &&
        compare(fromBase64(entries[position]!.key), key) === 0
      ) {
        entries[position] = encoded;
      } else {
        entries.splice(position, 0, encoded);
      }
      if (entries.length <= this.maxEntries) {
        return { page: await this.writePage({ kind: "leaf", entries }) };
      }
      const middle = entries.length >>> 1;
      const left = entries.slice(0, middle);
      const right = entries.slice(middle);
      const leftId = await this.writePage({ kind: "leaf", entries: left });
      const rightId = await this.writePage({ kind: "leaf", entries: right });
      return {
        page: leftId,
        split: { separator: fromBase64(right[0]!.key), right: rightId },
      };
    }

    const position = childIndex(page.keys, key);
    const child = await this.insert(page.children[position]!, key, value);
    const keys = [...page.keys];
    const children = [...page.children];
    children[position] = child.page;
    if (child.split !== undefined) {
      keys.splice(position, 0, toBase64(child.split.separator));
      children.splice(position + 1, 0, child.split.right);
    }
    if (keys.length <= this.maxEntries) {
      return {
        page: await this.writePage({ kind: "internal", keys, children }),
      };
    }
    const middle = keys.length >>> 1;
    const separator = fromBase64(keys[middle]!);
    const leftId = await this.writePage({
      kind: "internal",
      keys: keys.slice(0, middle),
      children: children.slice(0, middle + 1),
    });
    const rightId = await this.writePage({
      kind: "internal",
      keys: keys.slice(middle + 1),
      children: children.slice(middle + 1),
    });
    return { page: leftId, split: { separator, right: rightId } };
  }

  private async remove(
    id: RecordId,
    key: Uint8Array,
    root: boolean,
  ): Promise<DeleteResult> {
    const page = await this.#cache.get(id);
    if (page.kind === "leaf") {
      const entries = [...page.entries];
      const position = lowerBound(entries, key);
      if (
        entries[position] === undefined ||
        compare(fromBase64(entries[position]!.key), key) !== 0
      ) {
        return {
          page: id,
          changed: false,
          underflow: false,
          ...(entries[0] === undefined
            ? {}
            : { firstKey: fromBase64(entries[0].key) }),
        };
      }
      entries.splice(position, 1);
      return {
        page: await this.writePage({ kind: "leaf", entries }),
        changed: true,
        underflow: !root && entries.length < Math.ceil(this.maxEntries / 2),
        ...(entries[0] === undefined
          ? {}
          : { firstKey: fromBase64(entries[0].key) }),
      };
    }
    const position = childIndex(page.keys, key);
    const next = await this.remove(page.children[position]!, key, false);
    if (!next.changed) {
      return {
        page: id,
        changed: false,
        underflow: false,
        firstKey: await this.firstKey(id),
      };
    }
    const keys = [...page.keys];
    const children = [...page.children];
    children[position] = next.page;
    if (position > 0 && next.firstKey !== undefined) {
      keys[position - 1] = toBase64(next.firstKey);
    }
    if (next.underflow && children.length > 1) {
      await this.rebalanceChildren(keys, children, position);
    }
    const written = await this.writePage({ kind: "internal", keys, children });
    return {
      page: written,
      changed: true,
      underflow: !root && keys.length < Math.floor(this.maxEntries / 2),
      firstKey: await this.firstKey(children[0]!),
    };
  }

  private async rebalanceChildren(
    parentKeys: string[],
    children: RecordId[],
    childPosition: number,
  ): Promise<void> {
    const leftPosition = childPosition > 0 ? childPosition - 1 : childPosition;
    const rightPosition = leftPosition + 1;
    const left = await this.#cache.get(children[leftPosition]!);
    const right = await this.#cache.get(children[rightPosition]!);
    if (left.kind !== right.kind)
      throw new Error("B+ tree sibling type mismatch");

    if (left.kind === "leaf" && right.kind === "leaf") {
      const combined = [...left.entries, ...right.entries];
      if (combined.length <= this.maxEntries) {
        children[leftPosition] = await this.writePage({
          kind: "leaf",
          entries: combined,
        });
        children.splice(rightPosition, 1);
        parentKeys.splice(leftPosition, 1);
        return;
      }
      const middle = combined.length >>> 1;
      const leftEntries = combined.slice(0, middle);
      const rightEntries = combined.slice(middle);
      children[leftPosition] = await this.writePage({
        kind: "leaf",
        entries: leftEntries,
      });
      children[rightPosition] = await this.writePage({
        kind: "leaf",
        entries: rightEntries,
      });
      parentKeys[leftPosition] = rightEntries[0]!.key;
      return;
    }

    if (left.kind === "internal" && right.kind === "internal") {
      const combinedKeys = [
        ...left.keys,
        parentKeys[leftPosition]!,
        ...right.keys,
      ];
      const combinedChildren = [...left.children, ...right.children];
      if (combinedKeys.length <= this.maxEntries) {
        children[leftPosition] = await this.writePage({
          kind: "internal",
          keys: combinedKeys,
          children: combinedChildren,
        });
        children.splice(rightPosition, 1);
        parentKeys.splice(leftPosition, 1);
        return;
      }
      const middle = combinedKeys.length >>> 1;
      const promoted = combinedKeys[middle]!;
      children[leftPosition] = await this.writePage({
        kind: "internal",
        keys: combinedKeys.slice(0, middle),
        children: combinedChildren.slice(0, middle + 1),
      });
      children[rightPosition] = await this.writePage({
        kind: "internal",
        keys: combinedKeys.slice(middle + 1),
        children: combinedChildren.slice(middle + 1),
      });
      parentKeys[leftPosition] = promoted;
    }
  }

  private async firstKey(id: RecordId): Promise<Uint8Array> {
    let current = id;
    while (true) {
      const page = await this.#cache.get(current);
      if (page.kind === "leaf") {
        if (page.entries[0] === undefined) {
          throw new Error("Empty non-root leaf in B+ tree");
        }
        return fromBase64(page.entries[0].key);
      }
      current = page.children[0]!;
    }
  }

  private async *walk(
    id: RecordId,
    reverse: boolean,
  ): AsyncIterable<TreeEntry> {
    const page = await this.#cache.get(id);
    if (page.kind === "leaf") {
      const entries = reverse ? [...page.entries].reverse() : page.entries;
      for (const entry of entries) {
        yield { key: fromBase64(entry.key), value: fromBase64(entry.value) };
      }
      return;
    }
    const children = reverse ? [...page.children].reverse() : page.children;
    for (const child of children) yield* this.walk(child, reverse);
  }

  private async writePage(page: Page): Promise<RecordId> {
    return this.store.append("page", Buffer.from(JSON.stringify(page)));
  }

  private decodePage(payload: Uint8Array): Page {
    const page = JSON.parse(Buffer.from(payload).toString("utf8")) as Page;
    if (page.kind === "leaf" && Array.isArray(page.entries)) return page;
    if (
      page.kind === "internal" &&
      Array.isArray(page.keys) &&
      Array.isArray(page.children) &&
      page.children.length === page.keys.length + 1
    ) {
      return page;
    }
    throw new Error("Invalid B+ tree page");
  }
}
