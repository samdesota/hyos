import assert from "node:assert/strict";
import test from "node:test";

import { hydb, id, index, text } from "../src/index.js";

test("schema definitions are immutable values", () => {
  const status = hydb.enum("status", ["open", "closed"]);
  const tasks = hydb.table("tasks", {
    id: id().primaryKey(),
    status: status().notNull().default("open"),
  });
  const schema = hydb.schema({ tasks });

  assert.equal(Object.isFrozen(status), true);
  assert.equal(Object.isFrozen(tasks), true);
  assert.equal(Object.isFrozen(schema), true);
});

test("schema assembly rejects duplicate physical table names", () => {
  const tasks = hydb.table("tasks", { id: id().primaryKey() });

  assert.throws(
    () => hydb.schema({ tasks, tasksAlias: tasks }),
    /Duplicate table name: tasks/,
  );
});

test("schema assembly requires every table to have a primary key", () => {
  const events = hydb.table("events", { description: text().notNull() });

  assert.throws(
    () => hydb.schema({ events }),
    /Table events has no primary key/,
  );
});

test("schema assembly rejects references outside the schema", () => {
  const users = hydb.table("users", { id: id().primaryKey() });
  const tasks = hydb.table("tasks", {
    id: id().primaryKey(),
    assigneeId: id().references(() => users.id),
  });

  assert.throws(
    () => hydb.schema({ tasks }),
    /tasks.assigneeId references a column outside the schema/,
  );
});

test("an index cannot contain columns from another table", () => {
  const users = hydb.table("users", { id: id().primaryKey() });

  assert.throws(
    () =>
      hydb.table("tasks", { id: id().primaryKey() }, () => [
        index("tasks_user_idx").on(users.id),
      ]),
    /Index tasks_user_idx contains a column from another table/,
  );
});
