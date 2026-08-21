const columnBuilderDefinition = Symbol("hydb.column-builder");
const columnDefinition = Symbol("hydb.column");
const tableDefinition = Symbol("hydb.table");
const enumDefinition = Symbol("hydb.enum");
const schemaDefinition = Symbol("hydb.schema");
const indexDefinition = Symbol("hydb.index");

type ColumnBuilderConfig<
  Data,
  NotNull extends boolean,
  HasDefault extends boolean,
  PrimaryKey extends boolean,
> = Readonly<{
  dataType: string;
  notNull: NotNull;
  hasDefault: HasDefault;
  primaryKey: PrimaryKey;
  defaultValue?: Data;
  reference?: () => AnyColumn;
}>;

export type ColumnBuilder<
  Data,
  NotNull extends boolean = false,
  HasDefault extends boolean = false,
  PrimaryKey extends boolean = false,
> = Readonly<{
  [columnBuilderDefinition]: ColumnBuilderConfig<
    Data,
    NotNull,
    HasDefault,
    PrimaryKey
  >;
  notNull(): ColumnBuilder<Data, true, HasDefault, PrimaryKey>;
  default(value: Data): ColumnBuilder<Data, NotNull, true, PrimaryKey>;
  primaryKey(): ColumnBuilder<Data, true, HasDefault, true>;
  references(
    reference: () => Column<Data, boolean, boolean, boolean>,
  ): ColumnBuilder<Data, NotNull, HasDefault, PrimaryKey>;
}>;

export type AnyColumnBuilder = ColumnBuilder<any, boolean, boolean, boolean>;

export type Column<
  Data,
  NotNull extends boolean,
  HasDefault extends boolean,
  PrimaryKey extends boolean,
> = Readonly<{
  [columnDefinition]: ColumnBuilderConfig<
    Data,
    NotNull,
    HasDefault,
    PrimaryKey
  > & {
    tableName: string;
    name: string;
  };
}>;

export type AnyColumn = Column<any, boolean, boolean, boolean>;

function createColumnBuilder<
  Data,
  NotNull extends boolean,
  HasDefault extends boolean,
  PrimaryKey extends boolean,
>(
  config: ColumnBuilderConfig<Data, NotNull, HasDefault, PrimaryKey>,
): ColumnBuilder<Data, NotNull, HasDefault, PrimaryKey> {
  return Object.freeze({
    [columnBuilderDefinition]: config,

    notNull() {
      return createColumnBuilder({ ...config, notNull: true });
    },

    default(value: Data) {
      return createColumnBuilder({
        ...config,
        defaultValue: value,
        hasDefault: true,
      });
    },

    primaryKey() {
      return createColumnBuilder({
        ...config,
        notNull: true,
        primaryKey: true,
      });
    },

    references(reference: () => Column<Data, boolean, boolean, boolean>) {
      return createColumnBuilder({ ...config, reference });
    },
  });
}

function column<Data>(dataType: string): ColumnBuilder<Data> {
  return createColumnBuilder({
    dataType,
    notNull: false,
    hasDefault: false,
    primaryKey: false,
  });
}

export function id(): ColumnBuilder<string> {
  return column("id");
}

export function text(): ColumnBuilder<string> {
  return column("text");
}

export function integer(): ColumnBuilder<number> {
  return column("integer");
}

export function number(): ColumnBuilder<number> {
  return column("number");
}

export function boolean(): ColumnBuilder<boolean> {
  return column("boolean");
}

export function timestamp(): ColumnBuilder<Date> {
  return column("timestamp");
}

export function json<Data = unknown>(): ColumnBuilder<Data> {
  return column("json");
}

type BoundColumn<Builder extends AnyColumnBuilder> =
  Builder extends ColumnBuilder<
    infer Data,
    infer NotNull,
    infer HasDefault,
    infer PrimaryKey
  >
    ? Column<Data, NotNull, HasDefault, PrimaryKey>
    : never;

export type ColumnBuilderShape = Readonly<Record<string, AnyColumnBuilder>>;

type BoundColumns<Builders extends ColumnBuilderShape> = {
  readonly [Key in keyof Builders]: BoundColumn<Builders[Key]>;
};

export type IndexDefinition = Readonly<{
  [indexDefinition]: {
    name: string;
    unique: boolean;
    columns: readonly AnyColumn[];
  };
}>;

export type IndexBuilder = Readonly<{
  on(first: AnyColumn, ...rest: readonly AnyColumn[]): IndexDefinition;
}>;

function createIndexBuilder(name: string, unique: boolean): IndexBuilder {
  return Object.freeze({
    on(first: AnyColumn, ...rest: readonly AnyColumn[]) {
      return Object.freeze({
        [indexDefinition]: Object.freeze({
          name,
          unique,
          columns: Object.freeze([first, ...rest]),
        }),
      });
    },
  });
}

export function index(name: string): IndexBuilder {
  return createIndexBuilder(name, false);
}

export function uniqueIndex(name: string): IndexBuilder {
  return createIndexBuilder(name, true);
}

export type Table<
  Name extends string,
  Builders extends ColumnBuilderShape,
> = BoundColumns<Builders> &
  Readonly<{
    [tableDefinition]: {
      name: Name;
      columns: BoundColumns<Builders>;
      indexes: readonly IndexDefinition[];
    };
  }>;

export type AnyTable = Table<string, ColumnBuilderShape>;

export function getTableDefinition<TableValue extends AnyTable>(
  value: TableValue,
): TableValue[typeof tableDefinition] {
  return value[tableDefinition];
}

export function table<
  const Name extends string,
  const Builders extends ColumnBuilderShape,
>(
  name: Name,
  builders: Builders,
  defineIndexes?: (
    columns: BoundColumns<Builders>,
  ) => readonly IndexDefinition[],
): Table<Name, Builders> {
  const columns = Object.fromEntries(
    Object.entries(builders).map(([columnName, builder]) => [
      columnName,
      Object.freeze({
        [columnDefinition]: Object.freeze({
          ...builder[columnBuilderDefinition],
          tableName: name,
          name: columnName,
        }),
      }),
    ]),
  ) as unknown as BoundColumns<Builders>;

  const indexes = Object.freeze([...(defineIndexes?.(columns) ?? [])]);
  const names = new Set<string>();
  for (const value of indexes) {
    const definition = value[indexDefinition];
    if (names.has(definition.name)) {
      throw new TypeError(`Duplicate index name: ${definition.name}`);
    }
    names.add(definition.name);
    if (
      definition.columns.some(
        (indexedColumn) => indexedColumn[columnDefinition].tableName !== name,
      )
    ) {
      throw new TypeError(
        `Index ${definition.name} contains a column from another table`,
      );
    }
  }

  return Object.freeze(
    Object.defineProperty({ ...columns }, tableDefinition, {
      value: Object.freeze({ name, columns, indexes }),
    }),
  ) as Table<Name, Builders>;
}

export type EnumDefinition<Values extends readonly string[]> =
  (() => ColumnBuilder<Values[number]>) &
    Readonly<{
      [enumDefinition]: {
        name: string;
        values: Values;
      };
    }>;

export function enumeration<const Values extends readonly string[]>(
  name: string,
  values: Values,
): EnumDefinition<Values> {
  const definition = () => column<Values[number]>("enum");
  Object.defineProperty(definition, enumDefinition, {
    value: Object.freeze({ name, values: Object.freeze([...values]) }),
  });
  return Object.freeze(definition) as EnumDefinition<Values>;
}

type TableShape = Readonly<Record<string, AnyTable>>;

export type Schema<Tables extends TableShape> = Readonly<{
  [schemaDefinition]: {
    tables: Tables;
  };
}>;

export function schema<const Tables extends TableShape>(
  tables: Tables,
): Schema<Tables> {
  const definitions = Object.values(tables).map(
    (value) => value[tableDefinition],
  );
  const names = new Set<string>();
  const schemaColumns = new Set<AnyColumn>(
    definitions.flatMap((definition) => Object.values(definition.columns)),
  );

  for (const definition of definitions) {
    if (names.has(definition.name)) {
      throw new TypeError(`Duplicate table name: ${definition.name}`);
    }
    names.add(definition.name);

    const columns = Object.values(definition.columns);
    if (!columns.some((column) => column[columnDefinition].primaryKey)) {
      throw new TypeError(`Table ${definition.name} has no primary key`);
    }

    for (const column of columns) {
      const metadata = column[columnDefinition];
      const referencedColumn = metadata.reference?.();
      if (
        referencedColumn !== undefined &&
        !schemaColumns.has(referencedColumn)
      ) {
        throw new TypeError(
          `${definition.name}.${metadata.name} references a column outside the schema`,
        );
      }
    }
  }

  return Object.freeze(
    Object.defineProperty({}, schemaDefinition, {
      value: Object.freeze({ tables: Object.freeze({ ...tables }) }),
    }),
  ) as Schema<Tables>;
}

type BuilderOf<TableValue extends AnyTable> =
  TableValue extends Table<string, infer Builders> ? Builders : never;

type RowValue<Builder extends AnyColumnBuilder> =
  Builder extends ColumnBuilder<infer Data, infer NotNull, boolean, boolean>
    ? NotNull extends true
      ? Data
      : Data | null
    : never;

type RequiredInsertKey<Builders extends ColumnBuilderShape> = {
  [Key in keyof Builders]: Builders[Key] extends ColumnBuilder<
    any,
    true,
    false,
    boolean
  >
    ? Key
    : never;
}[keyof Builders];

type OptionalInsertKey<Builders extends ColumnBuilderShape> = Exclude<
  keyof Builders,
  RequiredInsertKey<Builders>
>;

type MutableKey<Builders extends ColumnBuilderShape> = {
  [Key in keyof Builders]: Builders[Key] extends ColumnBuilder<
    any,
    boolean,
    boolean,
    true
  >
    ? never
    : Key;
}[keyof Builders];

export type InferRow<TableValue extends AnyTable> = {
  -readonly [Key in keyof BuilderOf<TableValue>]: RowValue<
    BuilderOf<TableValue>[Key]
  >;
};

export type InferInsert<TableValue extends AnyTable> = {
  -readonly [Key in RequiredInsertKey<BuilderOf<TableValue>>]: RowValue<
    BuilderOf<TableValue>[Key]
  >;
} & {
  -readonly [Key in OptionalInsertKey<BuilderOf<TableValue>>]?: RowValue<
    BuilderOf<TableValue>[Key]
  >;
};

export type InferUpdate<TableValue extends AnyTable> = {
  -readonly [Key in MutableKey<BuilderOf<TableValue>>]?: RowValue<
    BuilderOf<TableValue>[Key]
  >;
};

export const schemaBuilders = {
  enum: enumeration,
  schema,
  table,
};
