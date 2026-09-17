export type KeyValueOperation =
  | Readonly<{ type: "put"; key: string; value: Uint8Array }>
  | Readonly<{ type: "delete"; key: string }>;

export type KeyValueCondition = Readonly<{
  key: string;
  /** Undefined means the key must not exist. */
  expected: Uint8Array | undefined;
}>;

/**
 * Binary values indexed by UTF-8 keys (1–480 bytes). Reads return owned copies.
 * getMany preserves input order, but does not promise a cross-key snapshot.
 * scan is a snapshot in UTF-8 byte order, taken when iteration begins.
 * after is exclusive; limit bounds the number of returned records. Callers
 * must finish/return the iterator promptly to release backend reader pins.
 *
 * batch atomically checks conditions and applies ordered edits. It owns copies
 * of inputs before returning control. Successful completion acknowledges durable
 * storage for persistent adapters; memory adapters only survive for their lifetime.
 * A failed condition applies nothing. Other failures may have an uncertain outcome:
 * close/reopen before retrying a publication. close drains admitted writes.
 */
export interface KeyValueStore {
  get(key: string): Promise<Uint8Array | undefined>;
  getMany(keys: readonly string[]): Promise<(Uint8Array | undefined)[]>;
  scan(
    prefix?: string,
    options?: Readonly<{ after?: string; limit?: number }>,
  ): AsyncIterable<Readonly<{ key: string; value: Uint8Array }>>;
  /** Same snapshot/order/cursor semantics as scan, without reading values. */
  scanKeys(
    prefix?: string,
    options?: Readonly<{ after?: string; limit?: number }>,
  ): AsyncIterable<string>;
  batch(
    operations: readonly KeyValueOperation[],
    conditions?: readonly KeyValueCondition[],
  ): Promise<void>;
  close(): Promise<void>;
}

export class KeyValueConflictError extends Error {
  constructor(readonly key: string) {
    super(
      `Key-value publication conflict at ${key}; reopen the storage before retrying`,
    );
    this.name = "KeyValueConflictError";
  }
}

export function keyBytes(key: string, prefix = false): Buffer {
  const bytes = Buffer.from(key, "utf8");
  if (
    (!prefix && bytes.length === 0) ||
    bytes.length > 480 ||
    bytes.toString("utf8") !== key
  ) {
    throw new TypeError("Key-value keys must be valid UTF-8, 1–480 bytes");
  }
  return bytes;
}

export function prepareBatch(
  operations: readonly KeyValueOperation[],
  conditions: readonly KeyValueCondition[],
) {
  return {
    operations: operations.map((op) => {
      keyBytes(op.key);
      return op.type === "put"
        ? { ...op, value: Uint8Array.from(op.value) }
        : { ...op };
    }),
    conditions: conditions.map((condition) => {
      keyBytes(condition.key);
      return {
        ...condition,
        expected:
          condition.expected === undefined
            ? undefined
            : Uint8Array.from(condition.expected),
      };
    }),
  };
}

export function checkValue(
  condition: KeyValueCondition,
  actual: Uint8Array | undefined,
): void {
  if (
    condition.expected === undefined
      ? actual !== undefined
      : actual === undefined || !Buffer.from(condition.expected).equals(actual)
  ) {
    throw new KeyValueConflictError(condition.key);
  }
}

export function scanBounds(
  prefix: string,
  options: { after?: string; limit?: number },
) {
  const start = keyBytes(prefix, true);
  const after =
    options.after === undefined ? undefined : keyBytes(options.after);
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new TypeError("Scan limit must be a positive safe integer");
  return {
    prefix: start,
    start: after && Buffer.compare(after, start) > 0 ? after : start,
    after,
    limit,
  };
}
