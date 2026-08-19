export type TableId = string
export type ColumnId = string
export type EncodedKey = Uint8Array
export type EncodedRow = Uint8Array
export type CommitVersion = bigint
export type Difference = bigint

export type RowChange = Readonly<{
  table: TableId
  key: EncodedKey
  before: EncodedRow | null
  after: EncodedRow | null
}>

export type CommitBatch = Readonly<{
  version: CommitVersion
  mutationId?: string
  changes: readonly RowChange[]
}>

export type DataflowUpdate<Row> = Readonly<{
  row: Row
  version: CommitVersion
  difference: Difference
}>
