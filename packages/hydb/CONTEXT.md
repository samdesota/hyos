# HyDB

HyDB is the real-time database context for Hyos personal applications. Its language separates application intent, atomic state changes, incremental query results, and synchronization policy.

## Language

**Command**:
A named, versioned application operation submitted as write intent and evaluated optimistically by a client before authoritative server acceptance.
_Avoid_: RPC, mutation, transaction

**Transaction**:
The atomic set of database changes attempted by a command. A command may produce one transaction, but the terms are not interchangeable.
_Avoid_: Command, RPC

**Materialized Query**:
A query whose current result is retained and updated incrementally as database changes arrive.
_Avoid_: Data graph, live query

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
