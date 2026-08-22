import {
  compareQueryValues,
  evaluateExpressionNode,
  expressionReferencesSource,
  getQueryPlan,
  isQueryNode,
  type ExpressionNode,
  type InferQueryResult,
  type Query,
  type QueryNode,
  type QuerySource,
} from "./query.js";
import { getTableDefinition } from "./schema.js";
import { encodeStorageKey, type CommittedChange } from "./storage.js";
import type { MemoryHandle, MemoryManager } from "./memory.js";
import { SpillableArrangement } from "./spill-arrangement.js";
import { decodeSpillValue, encodeSpillValue } from "./spill-codec.js";
import type { SpillCodec } from "./spill-sort.js";
import type { SpillSession } from "./spill.js";

type Row = Readonly<Record<string, unknown>>;

export type QueryDemand = Readonly<{
  source: QuerySource;
  context: ReadonlyMap<QuerySource, Row>;
  diff: number;
}>;

type Change<Value> = Readonly<{
  id: string;
  value: Value;
  diff: number;
}>;

type ChangeBatch<Value> = readonly Change<Value>[];
type ChangeHandler<Value> = (
  changes: ChangeBatch<Value>,
) => void | Promise<void>;

export type DataflowSpillOptions = Readonly<{
  memoryBytes: number;
  session: () => Promise<SpillSession>;
}>;

class DataflowMemory {
  readonly #handle?: MemoryHandle;
  readonly #sizes = new Map<object, number>();
  #bytes = 0;

  constructor(memory?: MemoryManager) {
    this.#handle = memory?.track({ owner: "dataflow", priority: 40 });
  }

  set(token: object, bytes: number): void {
    this.#bytes += bytes - (this.#sizes.get(token) ?? 0);
    this.#sizes.set(token, bytes);
    this.#handle?.resize(this.#bytes);
  }

  release(): void {
    this.#sizes.clear();
    this.#bytes = 0;
    this.#handle?.release();
  }
}

class Stream<Value> {
  readonly #handlers = new Set<ChangeHandler<Value>>();

  subscribe(handler: ChangeHandler<Value>): void {
    this.#handlers.add(handler);
  }

  async emit(changes: ChangeBatch<Value>): Promise<void> {
    if (changes.length === 0) return;
    for (const handler of this.#handlers) await handler(changes);
  }
}

type RowRecord = Readonly<{
  row: Row;
  ordinal: number;
}>;

type MatchRecord = Readonly<{
  group: string;
  context: ReadonlyMap<QuerySource, Row>;
  row: Row;
  ordinal: number;
}>;

type ProjectedRecord = Readonly<{
  group: string;
  match: MatchRecord;
  value: unknown;
}>;

type GroupRecord = Readonly<{
  group: string;
}>;

type MaterializedRecord = Readonly<{
  group: string;
  value: unknown;
}>;

const rootGroup = "hydb:root";
const failureMarker = Symbol("hydb.query.failure");

type QueryFailure = Readonly<{
  [failureMarker]: true;
  error: Error;
}>;

function failure(message: string): QueryFailure {
  return Object.freeze({ [failureMarker]: true, error: new Error(message) });
}

function isFailure(value: unknown): value is QueryFailure {
  return typeof value === "object" && value !== null && failureMarker in value;
}

function valuesEqualDeep(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, object>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)
  ) {
    return false;
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  const previous = seen.get(left);
  if (previous !== undefined) return previous === right;
  seen.set(left, right);

  if (left instanceof Map && right instanceof Map) {
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
      if (!right.has(key) || !valuesEqualDeep(value, right.get(key), seen)) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => valuesEqualDeep(value, right[index], seen))
    );
  }

  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        rightKeys.includes(key) &&
        valuesEqualDeep(
          (left as Record<PropertyKey, unknown>)[key],
          (right as Record<PropertyKey, unknown>)[key],
          seen,
        ),
    )
  );
}

function applyChanges<Value>(
  state: Map<string, Value>,
  changes: ChangeBatch<Value>,
): void {
  for (const change of changes) {
    if (change.diff === -1) state.delete(change.id);
    else state.set(change.id, change.value);
  }
}

function replacement<Value>(
  id: string,
  before: Value | undefined,
  after: Value | undefined,
): Change<Value>[] {
  if (
    before !== undefined &&
    after !== undefined &&
    valuesEqualDeep(before, after)
  ) {
    return [];
  }
  const changes: Change<Value>[] = [];
  if (before !== undefined) changes.push({ id, value: before, diff: -1 });
  if (after !== undefined) changes.push({ id, value: after, diff: 1 });
  return changes;
}

class InputOperator {
  readonly output = new Stream<RowRecord>();
  readonly #rows = new Map<string, RowRecord>();
  #nextOrdinal = 0;

  constructor(
    readonly table: string,
    initialRows: ReadonlyMap<string, Row>,
    private readonly memory?: DataflowMemory,
  ) {
    for (const [id, row] of initialRows) {
      this.#rows.set(id, { row, ordinal: this.#nextOrdinal++ });
    }
    this.account();
  }

  async bootstrap(): Promise<void> {
    await this.output.emit(
      [...this.#rows].map(([id, value]) => ({ id, value, diff: 1 })),
    );
  }

  async seed(rows: ReadonlyMap<string, Row>): Promise<void> {
    const output: Change<RowRecord>[] = [];
    for (const [id, row] of rows) {
      const before = this.#rows.get(id);
      const after = {
        row,
        ordinal: before?.ordinal ?? this.#nextOrdinal++,
      };
      this.#rows.set(id, after);
      output.push(...replacement(id, before, after));
    }
    await this.output.emit(output);
    this.account();
  }

  async remove(ids: readonly string[]): Promise<void> {
    const output: Change<RowRecord>[] = [];
    for (const id of ids) {
      const value = this.#rows.get(id);
      if (value === undefined) continue;
      this.#rows.delete(id);
      output.push({ id, value, diff: -1 });
    }
    await this.output.emit(output);
    this.account();
  }

  async apply(changes: readonly CommittedChange[]): Promise<void> {
    const output: Change<RowRecord>[] = [];
    for (const change of changes) {
      const id = encodeStorageKey(change.key);
      const before = this.#rows.get(id);
      if (before !== undefined) {
        output.push({ id, value: before, diff: -1 });
        this.#rows.delete(id);
      }
      if (change.after !== undefined) {
        const after = {
          row: change.after,
          ordinal: before?.ordinal ?? this.#nextOrdinal++,
        };
        this.#rows.set(id, after);
        output.push({ id, value: after, diff: 1 });
      }
    }
    await this.output.emit(output);
    this.account();
  }

  private account(): void {
    this.memory?.set(this, this.#rows.size * 128);
  }
}

class ConstantInputOperator<Value> {
  readonly output = new Stream<Value>();

  constructor(
    private readonly id: string,
    private readonly value: Value,
  ) {}

  async bootstrap(): Promise<void> {
    await this.output.emit([{ id: this.id, value: this.value, diff: 1 }]);
  }
}

class MapOperator<Input, Output> {
  readonly output = new Stream<Output>();

  constructor(input: Stream<Input>, map: (id: string, value: Input) => Output) {
    input.subscribe(async (changes) => {
      await this.output.emit(
        changes.map((change) => ({
          id: change.id,
          value: map(change.id, change.value),
          diff: change.diff,
        })),
      );
    });
  }
}

class FilterOperator<Value> {
  readonly output = new Stream<Value>();

  constructor(input: Stream<Value>, predicate: (value: Value) => boolean) {
    input.subscribe(async (changes) => {
      await this.output.emit(
        changes.filter((change) => predicate(change.value)),
      );
    });
  }
}

function arrangementCodec<Value>(
  sources: readonly QuerySource[],
): SpillCodec<Value> {
  const ids = new Map(sources.map((source, index) => [source, index]));
  return {
    encode(value) {
      const record = value as Record<string, unknown>;
      const context = record.context;
      return encodeSpillValue(
        context instanceof Map
          ? {
              ...record,
              context: [...context].map(([source, row]) => [
                ids.get(source as QuerySource),
                row,
              ]),
            }
          : value,
      );
    },
    decode(bytes) {
      const value = decodeSpillValue(bytes) as Record<string, unknown>;
      if (!Array.isArray(value.context)) return value as Value;
      return {
        ...value,
        context: new Map(
          (value.context as readonly (readonly [number, Row])[]).map(
            ([id, row]) => [sources[id]!, row],
          ),
        ),
      } as Value;
    },
  };
}

class ArrangeOperator<Value> {
  readonly output = new Stream<Value>();
  readonly #records = new Map<string, Value>();
  readonly #buckets = new Map<string, Set<string>>();
  readonly #spill?: SpillableArrangement<Value>;

  constructor(
    input: Stream<Value>,
    private readonly keyOf: (value: Value) => string,
    private readonly memory?: DataflowMemory,
    spill?: DataflowSpillOptions,
    sources: readonly QuerySource[] = [],
  ) {
    this.#spill =
      spill === undefined
        ? undefined
        : new SpillableArrangement(
            keyOf,
            arrangementCodec<Value>(sources),
            spill.memoryBytes,
            spill.session,
          );
    input.subscribe(async (changes) => {
      if (this.#spill === undefined) {
        for (const change of changes) {
          const key = this.keyOf(change.value);
          if (change.diff < 0) {
            this.#records.delete(change.id);
            const bucket = this.#buckets.get(key);
            bucket?.delete(change.id);
            if (bucket?.size === 0) this.#buckets.delete(key);
          } else {
            this.#records.set(change.id, change.value);
            const bucket = this.#buckets.get(key) ?? new Set<string>();
            bucket.add(change.id);
            this.#buckets.set(key, bucket);
          }
        }
      } else {
        await this.#spill.apply(changes);
      }
      this.account();
      await this.output.emit(changes);
    });
  }

  async lookup(key: string): Promise<readonly [string, Value][]> {
    if (this.#spill !== undefined) return this.#spill.lookup(key);
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) return [];
    const values: [string, Value][] = [];
    for (const id of bucket) {
      const value = this.#records.get(id);
      if (value !== undefined) values.push([id, value]);
    }
    return values;
  }

  private account(): void {
    this.memory?.set(
      this,
      this.#spill === undefined
        ? this.#records.size * 112 + this.#buckets.size * 48
        : this.#spill.residentBytes,
    );
  }
}

class JoinOperator<Left, Right, Output> {
  readonly output = new Stream<Output>();

  constructor(
    left: ArrangeOperator<Left>,
    right: ArrangeOperator<Right>,
    combine: (
      leftId: string,
      left: Left,
      rightId: string,
      right: Right,
    ) => Readonly<{ id: string; value: Output }>,
    leftKey: (value: Left) => string,
    rightKey: (value: Right) => string,
  ) {
    left.output.subscribe(async (changes) => {
      const output: Change<Output>[] = [];
      for (const change of changes) {
        for (const [rightId, rightValue] of await right.lookup(
          leftKey(change.value),
        )) {
          const joined = combine(change.id, change.value, rightId, rightValue);
          output.push({ ...joined, diff: change.diff });
        }
      }
      await this.output.emit(output);
    });
    right.output.subscribe(async (changes) => {
      const output: Change<Output>[] = [];
      for (const change of changes) {
        for (const [leftId, leftValue] of await left.lookup(
          rightKey(change.value),
        )) {
          const joined = combine(leftId, leftValue, change.id, change.value);
          output.push({ ...joined, diff: change.diff });
        }
      }
      await this.output.emit(output);
    });
  }
}

class OrderTopKOperator {
  readonly output = new Stream<MatchRecord>();
  readonly #records = new Map<string, MatchRecord>();
  readonly #spill?: SpillableArrangement<MatchRecord>;

  constructor(
    input: Stream<MatchRecord>,
    private readonly node: QueryNode,
    private readonly memory?: DataflowMemory,
    spill?: DataflowSpillOptions,
    sources: readonly QuerySource[] = [],
  ) {
    this.#spill =
      spill === undefined
        ? undefined
        : new SpillableArrangement(
            (record) => record.group,
            arrangementCodec<MatchRecord>(sources),
            spill.memoryBytes,
            spill.session,
          );
    input.subscribe((changes) => this.apply(changes));
  }

  private async selected(
    group: string,
  ): Promise<readonly [string, MatchRecord][]> {
    const records =
      this.#spill === undefined
        ? [...this.#records].filter(([, record]) => record.group === group)
        : [...(await this.#spill.lookup(group))];
    records.sort((left, right) => compareMatches(this.node, left, right));
    return this.node.limit === undefined
      ? records
      : records.slice(0, this.node.limit);
  }

  private async apply(changes: ChangeBatch<MatchRecord>): Promise<void> {
    const groups = new Set(changes.map((change) => change.value.group));
    const before = new Map<string, readonly [string, MatchRecord][]>();
    for (const group of groups) before.set(group, await this.selected(group));
    if (this.#spill === undefined) applyChanges(this.#records, changes);
    else await this.#spill.apply(changes);
    this.memory?.set(
      this,
      this.#spill === undefined
        ? this.#records.size * 112
        : this.#spill.residentBytes,
    );

    const output: Change<MatchRecord>[] = [];
    for (const group of groups) {
      const oldValues = new Map(before.get(group) ?? []);
      const newValues = new Map(await this.selected(group));
      for (const [id, value] of oldValues) {
        if (!newValues.has(id)) output.push({ id, value, diff: -1 });
      }
      for (const [id, value] of newValues) {
        const oldValue = oldValues.get(id);
        if (oldValue === undefined) output.push({ id, value, diff: 1 });
        else output.push(...replacement(id, oldValue, value));
      }
    }
    await this.output.emit(output);
  }
}

function compareMatches(
  node: QueryNode,
  left: readonly [string, MatchRecord],
  right: readonly [string, MatchRecord],
): number {
  for (const order of node.order) {
    const comparison = compareQueryValues(
      evaluateExpressionNode(order.expression, left[1].context),
      evaluateExpressionNode(order.expression, right[1].context),
    );
    if (comparison !== 0) {
      return order.direction === "asc" ? comparison : -comparison;
    }
  }
  const ordinal = left[1].ordinal - right[1].ordinal;
  return ordinal === 0 ? left[0].localeCompare(right[0]) : ordinal;
}

class NestOperator {
  readonly output = new Stream<ProjectedRecord>();
  readonly #left = new Map<string, ProjectedRecord>();
  readonly #right = new Map<string, MaterializedRecord>();

  constructor(
    left: Stream<ProjectedRecord>,
    right: Stream<MaterializedRecord>,
    private readonly property: string,
    private readonly memory?: DataflowMemory,
  ) {
    left.subscribe((changes) => this.applyLeft(changes));
    right.subscribe((changes) => this.applyRight(changes));
  }

  private combined(id: string): ProjectedRecord | undefined {
    const left = this.#left.get(id);
    const right = this.#right.get(id);
    if (left === undefined || right === undefined) return undefined;
    if (isFailure(left.value)) return left;
    if (isFailure(right.value)) return { ...left, value: right.value };
    return {
      ...left,
      value: {
        ...(left.value as Record<string, unknown>),
        [this.property]: right.value,
      },
    };
  }

  private async applyLeft(
    changes: ChangeBatch<ProjectedRecord>,
  ): Promise<void> {
    const ids = new Set(changes.map((change) => change.id));
    const before = new Map([...ids].map((id) => [id, this.combined(id)]));
    applyChanges(this.#left, changes);
    this.account();
    await this.emitReplacements(ids, before);
  }

  private async applyRight(
    changes: ChangeBatch<MaterializedRecord>,
  ): Promise<void> {
    const ids = new Set(changes.map((change) => change.id));
    const before = new Map([...ids].map((id) => [id, this.combined(id)]));
    applyChanges(this.#right, changes);
    this.account();
    await this.emitReplacements(ids, before);
  }

  private emitReplacements(
    ids: ReadonlySet<string>,
    before: ReadonlyMap<string, ProjectedRecord | undefined>,
  ): Promise<void> {
    const output: Change<ProjectedRecord>[] = [];
    for (const id of ids) {
      output.push(...replacement(id, before.get(id), this.combined(id)));
    }
    return this.output.emit(output);
  }

  private account(): void {
    this.memory?.set(this, (this.#left.size + this.#right.size) * 112);
  }
}

class ReduceOperator {
  readonly output = new Stream<MaterializedRecord>();
  readonly #counts = new Map<string, number>();
  readonly #groups = new Map<string, GroupRecord>();

  constructor(
    input: Stream<MatchRecord>,
    groups: Stream<GroupRecord>,
    private readonly kind: "count" | "exists",
    private readonly memory?: DataflowMemory,
  ) {
    input.subscribe((changes) => this.applyInput(changes));
    groups.subscribe((changes) => this.applyGroups(changes));
  }

  private materialize(groupId: string): MaterializedRecord | undefined {
    const group = this.#groups.get(groupId);
    if (group === undefined) return undefined;
    const count = this.#counts.get(groupId) ?? 0;
    return {
      group: group.group,
      value: this.kind === "count" ? count : count > 0,
    };
  }

  private async applyInput(changes: ChangeBatch<MatchRecord>): Promise<void> {
    const deltas = new Map<string, number>();
    for (const change of changes) {
      deltas.set(
        change.value.group,
        (deltas.get(change.value.group) ?? 0) + change.diff,
      );
    }
    const groups = new Set(deltas.keys());
    const before = new Map(
      [...groups].map((group) => [group, this.materialize(group)]),
    );
    for (const [group, delta] of deltas) {
      const count = (this.#counts.get(group) ?? 0) + delta;
      if (count === 0) this.#counts.delete(group);
      else this.#counts.set(group, count);
    }
    this.account();
    await this.emitGroups(groups, before);
  }

  private async applyGroups(changes: ChangeBatch<GroupRecord>): Promise<void> {
    const groups = new Set(changes.map((change) => change.id));
    const before = new Map(
      [...groups].map((group) => [group, this.materialize(group)]),
    );
    applyChanges(this.#groups, changes);
    this.account();
    await this.emitGroups(groups, before);
  }

  private emitGroups(
    groups: ReadonlySet<string>,
    before: ReadonlyMap<string, MaterializedRecord | undefined>,
  ): Promise<void> {
    const output: Change<MaterializedRecord>[] = [];
    for (const group of groups) {
      output.push(
        ...replacement(group, before.get(group), this.materialize(group)),
      );
    }
    return this.output.emit(output);
  }

  private account(): void {
    this.memory?.set(this, this.#counts.size * 48 + this.#groups.size * 64);
  }
}

class CardinalityOperator {
  readonly output = new Stream<MaterializedRecord>();
  readonly #items = new Map<string, ProjectedRecord>();
  readonly #groups = new Map<string, GroupRecord>();

  constructor(
    items: Stream<ProjectedRecord>,
    groups: Stream<GroupRecord>,
    private readonly node: QueryNode,
    private readonly memory?: DataflowMemory,
  ) {
    items.subscribe((changes) => this.applyItems(changes));
    groups.subscribe((changes) => this.applyGroups(changes));
  }

  private materialize(groupId: string): MaterializedRecord | undefined {
    const group = this.#groups.get(groupId);
    if (group === undefined) return undefined;
    const entries = [...this.#items].filter(
      ([, item]) => item.group === groupId,
    );
    entries.sort((left, right) =>
      compareMatches(
        this.node,
        [left[0], left[1].match],
        [right[0], right[1].match],
      ),
    );
    const values = entries.map(([, item]) => item.value);
    const nestedFailure = values.find(isFailure);
    if (nestedFailure !== undefined) {
      return { group: group.group, value: nestedFailure };
    }

    let value: unknown;
    switch (this.node.cardinality) {
      case "many":
        value = values;
        break;
      case "one":
        value =
          values.length > 1
            ? failure("Expected at most one query row")
            : (values[0] ?? null);
        break;
      case "require":
        value =
          values.length === 1
            ? values[0]
            : failure("Expected exactly one query row");
        break;
      case "count":
        value = values.length;
        break;
      case "exists":
        value = values.length > 0;
        break;
      default:
        value = failure("Query cardinality is required");
    }
    return { group: group.group, value };
  }

  private async applyItems(
    changes: ChangeBatch<ProjectedRecord>,
  ): Promise<void> {
    const groups = new Set(changes.map((change) => change.value.group));
    const before = new Map(
      [...groups].map((group) => [group, this.materialize(group)]),
    );
    applyChanges(this.#items, changes);
    this.account();
    await this.emitGroups(groups, before);
  }

  private async applyGroups(changes: ChangeBatch<GroupRecord>): Promise<void> {
    const groups = new Set(changes.map((change) => change.id));
    const before = new Map(
      [...groups].map((group) => [group, this.materialize(group)]),
    );
    applyChanges(this.#groups, changes);
    this.account();
    await this.emitGroups(groups, before);
  }

  private emitGroups(
    groups: ReadonlySet<string>,
    before: ReadonlyMap<string, MaterializedRecord | undefined>,
  ): Promise<void> {
    const output: Change<MaterializedRecord>[] = [];
    for (const group of groups) {
      output.push(
        ...replacement(group, before.get(group), this.materialize(group)),
      );
    }
    return this.output.emit(output);
  }

  private account(): void {
    this.memory?.set(this, this.#items.size * 112 + this.#groups.size * 64);
  }
}

class OutputOperator<Result> {
  readonly #values = new Map<string, MaterializedRecord>();
  #before: unknown;
  #listener?: (result: Result) => void;

  constructor(
    input: Stream<MaterializedRecord>,
    listener: (result: Result) => void,
    private readonly memory?: DataflowMemory,
  ) {
    this.#listener = listener;
    input.subscribe((changes) => {
      applyChanges(this.#values, changes);
      this.memory?.set(this, this.#values.size * 112);
    });
  }

  begin(): void {
    this.#before = this.currentValue();
  }

  publishInitial(): void {
    this.#listener?.(structuredClone(this.read()));
  }

  flush(): void {
    const current = this.currentValue();
    if (!valuesEqualDeep(this.#before, current)) {
      this.#listener?.(structuredClone(this.read()));
    }
    this.#before = undefined;
  }

  dispose(): void {
    this.#listener = undefined;
  }

  private currentValue(): unknown {
    return this.#values.get(rootGroup)?.value;
  }

  private read(): Result {
    const value = this.currentValue();
    if (isFailure(value)) throw value.error;
    return value as Result;
  }
}

function arrangementKey(value: unknown): string {
  try {
    return encodeStorageKey([value]);
  } catch {
    return `unsupported:${String(value)}`;
  }
}

function correlation(
  node: QueryNode,
): Readonly<{ child: ExpressionNode; parent: ExpressionNode }> | undefined {
  for (const filter of node.filters) {
    if (filter.type !== "comparison" || filter.operator !== "eq") continue;
    const leftIsChild = expressionReferencesSource(filter.left, node.source);
    const rightIsChild = expressionReferencesSource(filter.right, node.source);
    if (leftIsChild && !rightIsChild) {
      return { child: filter.left, parent: filter.right };
    }
    if (rightIsChild && !leftIsChild) {
      return { child: filter.right, parent: filter.left };
    }
  }
  return undefined;
}

type SourceRows = ReadonlyMap<QuerySource, ReadonlyMap<string, Row>>;
type CompiledMatches = Readonly<{
  matches: Stream<MatchRecord>;
  groups: Stream<GroupRecord>;
}>;

class QueryCompiler {
  readonly #inputs = new Map<QuerySource, InputOperator>();
  readonly #rootGroups = new ConstantInputOperator<GroupRecord>(rootGroup, {
    group: rootGroup,
  });
  readonly memory: DataflowMemory;
  readonly #sourceList: readonly QuerySource[];

  private sources: SourceRows | undefined;

  constructor(
    sources: SourceRows,
    private readonly onDemand?: (demands: readonly QueryDemand[]) => void,
    memoryManager?: MemoryManager,
    private readonly spill?: DataflowSpillOptions,
  ) {
    this.sources = sources;
    this.#sourceList = [...sources.keys()];
    this.memory = new DataflowMemory(memoryManager);
  }

  compile(node: QueryNode): Stream<MaterializedRecord> {
    return this.compileNode(node);
  }

  async bootstrap(): Promise<void> {
    for (const input of this.#inputs.values()) await input.bootstrap();
    await this.#rootGroups.bootstrap();
  }

  releaseInitialRows(): void {
    this.sources = undefined;
  }

  async apply(
    source: QuerySource,
    changes: readonly CommittedChange[],
  ): Promise<void> {
    await this.#inputs.get(source)?.apply(changes);
  }

  async seed(
    source: QuerySource,
    rows: ReadonlyMap<string, Row>,
  ): Promise<void> {
    await this.#inputs.get(source)?.seed(rows);
  }

  async remove(source: QuerySource, ids: readonly string[]): Promise<void> {
    await this.#inputs.get(source)?.remove(ids);
  }

  private input(source: QuerySource): InputOperator {
    let input = this.#inputs.get(source);
    if (input !== undefined) return input;
    const rows = this.sources?.get(source);
    if (rows === undefined) {
      throw new TypeError(`Unknown query source: ${source.table}`);
    }
    input = new InputOperator(source.table, rows, this.memory);
    this.#inputs.set(source, input);
    return input;
  }

  private compileNode(
    node: QueryNode,
    parents?: Stream<MatchRecord>,
  ): Stream<MaterializedRecord> {
    const { matches, groups } = this.compileMatches(node, parents);

    if (node.cardinality === "count" || node.cardinality === "exists") {
      return new ReduceOperator(matches, groups, node.cardinality, this.memory)
        .output;
    }

    let projected: Stream<ProjectedRecord> = new MapOperator(
      matches,
      (_id, match): ProjectedRecord => {
        if (node.selection === undefined) {
          return {
            group: match.group,
            match,
            value: structuredClone(match.row),
          };
        }
        return {
          group: match.group,
          match,
          value: Object.fromEntries(
            Object.entries(node.selection)
              .filter(([, value]) => !isQueryNode(value))
              .map(([name, value]) => [
                name,
                structuredClone(
                  evaluateExpressionNode(
                    value as ExpressionNode,
                    match.context,
                  ),
                ),
              ]),
          ),
        };
      },
    ).output;

    if (node.selection !== undefined) {
      for (const [name, selection] of Object.entries(node.selection)) {
        if (!isQueryNode(selection)) continue;
        const nested = this.compileNode(selection, matches);
        projected = new NestOperator(projected, nested, name, this.memory)
          .output;
      }
    }

    return new CardinalityOperator(projected, groups, node, this.memory).output;
  }

  private compileMatches(
    node: QueryNode,
    parents?: Stream<MatchRecord>,
  ): CompiledMatches {
    const source = this.input(node.source).output;
    let matches: Stream<MatchRecord>;
    let groups: Stream<GroupRecord>;

    if (parents === undefined) {
      matches = new MapOperator(source, (id, value): MatchRecord => {
        const context = new Map<QuerySource, Row>();
        context.set(node.source, value.row);
        return {
          group: rootGroup,
          context,
          row: value.row,
          ordinal: value.ordinal,
        };
      }).output;
      groups = this.#rootGroups.output;
    } else {
      parents.subscribe((changes) => {
        this.onDemand?.(
          changes.map((change) => ({
            source: node.source,
            context: change.value.context,
            diff: change.diff,
          })),
        );
      });
      const key = correlation(node);
      const parentKey = (parent: MatchRecord) =>
        key === undefined
          ? rootGroup
          : arrangementKey(evaluateExpressionNode(key.parent, parent.context));
      const childKey = (child: RowRecord) => {
        if (key === undefined) return rootGroup;
        const context = new Map<QuerySource, Row>();
        context.set(node.source, child.row);
        return arrangementKey(evaluateExpressionNode(key.child, context));
      };
      const left = new ArrangeOperator(
        parents,
        parentKey,
        this.memory,
        this.spill,
        this.#sourceList,
      );
      const right = new ArrangeOperator(
        source,
        childKey,
        this.memory,
        this.spill,
        this.#sourceList,
      );
      matches = new JoinOperator<MatchRecord, RowRecord, MatchRecord>(
        left,
        right,
        (parentId, parent, childId, child) => {
          const context = new Map(parent.context);
          context.set(node.source, child.row);
          return {
            id: `${parentId}\u0000${node.source.table}:${childId}`,
            value: {
              group: parentId,
              context,
              row: child.row,
              ordinal: child.ordinal,
            },
          };
        },
        parentKey,
        childKey,
      ).output;
      groups = new MapOperator(parents, (_id, parent): GroupRecord => ({
        group: parent.group,
      })).output;
    }

    if (node.authorization !== undefined) {
      const authorizedParents = this.compileMatches(
        node.authorization.parent,
      ).matches;
      const childKey = (match: MatchRecord) =>
        arrangementKey(match.row[node.authorization!.childColumn]);
      const parentKey = (match: MatchRecord) =>
        arrangementKey(match.row[node.authorization!.parentColumn]);
      const children = new ArrangeOperator(
        matches,
        childKey,
        this.memory,
        this.spill,
        this.#sourceList,
      );
      const allowed = new ArrangeOperator(
        authorizedParents,
        parentKey,
        this.memory,
        this.spill,
        this.#sourceList,
      );
      matches = new JoinOperator<MatchRecord, MatchRecord, MatchRecord>(
        children,
        allowed,
        (childId, child) => ({ id: childId, value: child }),
        childKey,
        parentKey,
      ).output;
    }

    matches = new FilterOperator(matches, (match) =>
      node.filters.every((filter) =>
        Boolean(evaluateExpressionNode(filter, match.context)),
      ),
    ).output;
    matches = new OrderTopKOperator(
      matches,
      node,
      this.memory,
      this.spill,
      this.#sourceList,
    ).output;
    return { matches, groups };
  }
}

export class DifferentialQuery<QueryValue extends Query<any>> {
  readonly #compiler: QueryCompiler;
  readonly #output: OutputOperator<InferQueryResult<QueryValue>>;

  constructor(
    query: QueryValue,
    sources: SourceRows,
    listener: (result: InferQueryResult<QueryValue>) => void,
    onDemand?: (demands: readonly QueryDemand[]) => void,
    memoryManager?: MemoryManager,
    spill?: DataflowSpillOptions,
  ) {
    this.#compiler = new QueryCompiler(sources, onDemand, memoryManager, spill);
    const result = this.#compiler.compile(getQueryPlan(query));
    this.#compiler.releaseInitialRows();
    this.#output = new OutputOperator(result, listener, this.#compiler.memory);
  }

  bootstrap(): Promise<void> {
    return this.#compiler.bootstrap();
  }

  publishInitial(): void {
    this.#output.publishInitial();
  }

  begin(): void {
    this.#output.begin();
  }

  apply(
    source: QuerySource,
    changes: readonly CommittedChange[],
  ): Promise<void> {
    return this.#compiler.apply(source, changes);
  }

  seed(source: QuerySource, rows: ReadonlyMap<string, Row>): Promise<void> {
    return this.#compiler.seed(source, rows);
  }

  remove(source: QuerySource, ids: readonly string[]): Promise<void> {
    return this.#compiler.remove(source, ids);
  }

  flush(): void {
    this.#output.flush();
  }

  dispose(): void {
    this.#output.dispose();
    this.#compiler.memory.release();
  }
}
