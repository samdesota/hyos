import {
  defineTable,
  enumeration,
  id,
  integer,
  string,
  timestamp,
  type InferInsert,
  type InferRow,
  type InferUpdate,
} from '../src/schema/index.js'

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends
  (<Type>() => Type extends Right ? 1 : 2) ? true : false
type Expect<Value extends true> = Value
type Simplify<Value> = {[Key in keyof Value]: Value[Key]}

const taskStatus = enumeration('type_test_status', ['todo', 'doing', 'done'])
const tasks = defineTable('type_test_tasks', {
  id: id().primaryKey(),
  projectId: id().notNull(),
  assigneeId: id(),
  title: string().notNull(),
  status: taskStatus().notNull().default('todo'),
  priority: integer().notNull().default(0),
  createdAt: timestamp().notNull(),
})

type ExpectedRow = {
  id: string
  projectId: string
  assigneeId: string | null
  title: string
  status: 'todo' | 'doing' | 'done'
  priority: number
  createdAt: Date
}

type ExpectedInsert = {
  id: string
  projectId: string
  assigneeId?: string | null
  title: string
  status?: 'todo' | 'doing' | 'done'
  priority?: number
  createdAt: Date
}

type ExpectedUpdate = {
  projectId?: string
  assigneeId?: string | null
  title?: string
  status?: 'todo' | 'doing' | 'done'
  priority?: number
  createdAt?: Date
}

type RowMatches = Expect<Equal<Simplify<InferRow<typeof tasks>>, ExpectedRow>>
type InsertMatches = Expect<Equal<Simplify<InferInsert<typeof tasks>>, ExpectedInsert>>
type UpdateMatches = Expect<Equal<Simplify<InferUpdate<typeof tasks>>, ExpectedUpdate>>

const insert: InferInsert<typeof tasks> = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Build HyDB',
  createdAt: new Date(),
}
const update: InferUpdate<typeof tasks> = {assigneeId: null, status: 'doing'}

// @ts-expect-error required insert fields cannot be omitted
const missingTitle: InferInsert<typeof tasks> = {
  id: 'task-1', projectId: 'project-1', createdAt: new Date(),
}
// @ts-expect-error primary keys are immutable
const updatesPrimaryKey: InferUpdate<typeof tasks> = {id: 'task-2'}
// @ts-expect-error enumeration values remain a literal union
const invalidStatus: InferUpdate<typeof tasks> = {status: 'blocked'}

void (null as unknown as RowMatches)
void (null as unknown as InsertMatches)
void (null as unknown as UpdateMatches)
void insert
void update
void missingTitle
void updatesPrimaryKey
void invalidStatus
