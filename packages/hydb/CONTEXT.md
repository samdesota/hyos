# HyDB

HyDB is the real-time database context for Hyos personal applications. Its language separates application intent, atomic state changes, incremental query results, and synchronization policy.

## Language

**Table**:
A schema-defined set of records in which each primary key identifies at most one current record.
_Avoid_: Collection, document collection

**Collection**:
An internal multiset of dataflow records represented by weighted changes over logical time.
_Avoid_: Table, record set

**Schema IR**:
A stable, serializable description of tables, fields, types, constraints, references, and declared indexes from which runtime validation and TypeScript types are derived.
_Avoid_: TypeScript type, schema callback

**Index**:
A schema-declared, named access path maintained for a table, including those required to enforce unique constraints.
_Avoid_: Arrangement, query cache

**Arrangement**:
A query-engine-maintained, potentially shared index over a Collection and its weighted history.
_Avoid_: Index, materialized query

**Command**:
A named, versioned application operation submitted as write intent and evaluated optimistically by a client before authoritative server acceptance.
_Avoid_: RPC, mutation, transaction

**Transaction**:
The atomic set of database changes attempted by a command. A command may produce one transaction, but the terms are not interchangeable.
_Avoid_: Command, RPC

**Materialized Query**:
A query whose current result is retained and updated incrementally as database changes arrive.
_Avoid_: Data graph, live query

**Selection IR**:
A stable, serializable, hierarchical query document describing parameters, nested relationship selections, cardinality, aliases, and returned shape.
_Avoid_: Query callback, relational plan

**Relational IR**:
A normalized directed acyclic graph of relational operators compiled from Selection IR.
_Avoid_: Selection document, physical plan

**Result Shape IR**:
A description of how relational results and their hidden identities assemble into returned nested values.
_Avoid_: Selection IR, JSON patch

**Selection Fragment**:
A reusable, source-bound, typed template that maps one record into a shaped result and is expanded into Selection IR during query construction.
_Avoid_: Query fragment, runtime fragment

**Physical Dataflow Plan**:
An engine-specific executable graph containing operator placement, arrangements, shared traces, and materialization choices.
_Avoid_: Logical query, query definition

**Conflict Strategy**:
A selectable policy that resolves concurrent or offline command effects when synchronizing with authoritative state.
_Avoid_: Conflict handler, merge mode

**Optimistic Evaluation**:
Local evaluation of a command and its affected materialized queries before the server accepts or rejects that command.
_Avoid_: Optimistic write, local transaction

**Principal Context**:
The authenticated identity, memberships, roles, capabilities, and stable policy inputs against which access decisions are evaluated.
_Avoid_: User context, session user

**Read Policy**:
A query-derived rule defining which data a Principal Context may observe.
_Avoid_: Permission filter, user slice

**Command Authorization**:
The authoritative decision to permit or reject a command using its arguments, current database state, and Principal Context.
_Avoid_: Write policy, read permission

**Replica**:
The local database state, synchronization position, replica selection, and pending command stream belonging to one client installation.
_Avoid_: User slice, frontend database

**Command Envelope**:
A uniquely identified, versioned command invocation and its arguments submitted for authoritative execution.
_Avoid_: Mutation payload, transaction request
