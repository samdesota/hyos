import assert from "node:assert/strict";
import test from "node:test";

import { query } from "../src/query.js";
import {
  hydb,
  id,
  index,
  integer,
  planQuery,
  text,
  uniqueIndex,
} from "../src/index.js";

const projects = hydb.table(
  "projects",
  {
    id: id().primaryKey(),
    slug: text().notNull(),
    name: text().notNull(),
  },
  (columns) => [
    uniqueIndex("projects_slug_idx").on(columns.slug),
    index("projects_slug_name_idx").on(columns.slug, columns.name),
  ],
);

const tasks = hydb.table(
  "tasks",
  {
    id: id().primaryKey(),
    projectId: id()
      .notNull()
      .references(() => projects.id),
    status: text().notNull(),
    position: integer().notNull(),
    title: text().notNull(),
  },
  (columns) => [
    index("tasks_project_status_position_idx").on(
      columns.projectId,
      columns.status,
      columns.position,
    ),
    index("tasks_project_position_idx").on(columns.projectId, columns.position),
    index("tasks_status_idx").on(columns.status),
  ],
);

const schema = hydb.schema({ projects, tasks });

test("an exact primary-key predicate plans a point lookup", () => {
  const planned = planQuery(
    schema,
    query(tasks)
      .where((task) => task.id.eq("task-1"))
      .many(),
  );

  assert.equal(planned.access.kind, "primary-key");
  assert.deepEqual(planned.access.key, [{ kind: "literal", value: "task-1" }]);
  assert.deepEqual(planned.filters, []);
});

test("an exact unique index wins over non-unique candidates", () => {
  const planned = planQuery(
    schema,
    query(projects)
      .where((project) => project.slug.eq("hydb"))
      .many(),
  );

  assert.equal(planned.access.kind, "index-scan");
  assert.equal(planned.access.index, "projects_slug_idx");
  assert.deepEqual(planned.filters, []);
});

test("a composite index absorbs its equality prefix, ordering, and safe limit", () => {
  const planned = planQuery(
    schema,
    query(tasks)
      .where((task) => task.projectId.eq("project-1"))
      .where((task) => task.status.eq("open"))
      .orderBy((task) => task.position.asc())
      .limit(20)
      .many(),
  );

  assert.equal(planned.access.kind, "index-scan");
  assert.equal(planned.access.index, "tasks_project_status_position_idx");
  assert.deepEqual(planned.access.key, [
    { kind: "literal", value: "project-1" },
    { kind: "literal", value: "open" },
  ]);
  assert.equal(planned.access.reverse, false);
  assert.equal(planned.access.limit, 20);
  assert.deepEqual(planned.filters, []);
  assert.deepEqual(planned.order, []);
});

test("unsearchable predicates and ordering remain above a table scan", () => {
  const planned = planQuery(
    schema,
    query(tasks)
      .where((task) => task.title.ne("Archived"))
      .orderBy((task) => task.title.desc())
      .limit(5)
      .many(),
  );

  assert.equal(planned.access.kind, "table-scan");
  assert.equal(planned.access.limit, undefined);
  assert.equal(planned.filters.length, 1);
  assert.equal(planned.order.length, 1);
});

test("an index can provide ordering without an equality predicate", () => {
  const planned = planQuery(
    schema,
    query(tasks)
      .orderBy((task) => task.status.desc())
      .limit(5)
      .many(),
  );

  assert.equal(planned.access.kind, "index-scan");
  assert.equal(planned.access.index, "tasks_status_idx");
  assert.deepEqual(planned.access.key, []);
  assert.equal(planned.access.reverse, true);
  assert.equal(planned.access.limit, 5);
  assert.deepEqual(planned.order, []);
});

test("nested queries plan correlated index lookups using outer-field bindings", () => {
  const planned = planQuery(
    schema,
    query(projects)
      .select((project) => ({
        id: project.id,
        tasks: query(tasks)
          .where((task) => task.projectId.eq(project.id))
          .orderBy((task) => task.position.asc())
          .many(),
      }))
      .many(),
  );

  assert.equal(planned.selection?.id.kind, "expression");
  const nested = planned.selection?.tasks;
  assert.equal(nested?.kind, "query");
  if (nested?.kind !== "query") assert.fail("Expected a nested query plan");

  assert.equal(nested.plan.access.kind, "index-scan");
  assert.equal(nested.plan.access.index, "tasks_project_position_idx");
  assert.equal(nested.plan.access.key[0]?.kind, "outer-field");
  if (nested.plan.access.key[0]?.kind !== "outer-field") {
    assert.fail("Expected a correlated outer-field binding");
  }
  assert.equal(nested.plan.access.key[0].column, "id");
  assert.deepEqual(nested.plan.filters, []);
  assert.deepEqual(nested.plan.order, []);
  assert.deepEqual(nested.plan.join, { kind: "indexed-loop" });
});

test("an unindexed equality correlation plans an adaptive hash join", () => {
  const notes = hydb.table("planner_notes", {
    id: id().primaryKey(),
    projectId: id().notNull(),
    body: text().notNull(),
  });
  const localSchema = hydb.schema({ projects, notes });
  const planned = planQuery(
    localSchema,
    query(projects)
      .select((project) => ({
        notes: query(notes)
          .where((note) => note.projectId.eq(project.id))
          .many(),
      }))
      .many(),
  );
  const nested = planned.selection?.notes;
  assert.equal(nested?.kind, "query");
  if (nested?.kind !== "query") assert.fail("Expected a nested query plan");
  assert.equal(nested.plan.access.kind, "table-scan");
  assert.deepEqual(nested.plan.join, {
    kind: "hash",
    childColumn: "projectId",
    parent: {
      kind: "outer-field",
      source: planned.source,
      column: "id",
    },
  });
});

test("a table scan uses primary-key ordering in either direction", () => {
  const planned = planQuery(
    schema,
    query(tasks)
      .orderBy((task) => task.id.desc())
      .limit(3)
      .many(),
  );

  assert.equal(planned.access.kind, "table-scan");
  assert.equal(planned.access.reverse, true);
  assert.equal(planned.access.limit, 3);
  assert.deepEqual(planned.order, []);
});

test("short-circuit cardinalities push a one-row limit into a safe scan", () => {
  const planned = planQuery(
    schema,
    query(tasks)
      .where((task) => task.status.eq("open"))
      .exists(),
  );

  assert.equal(planned.cardinality, "exists");
  assert.equal(planned.access.kind, "index-scan");
  assert.equal(planned.access.index, "tasks_status_idx");
  assert.equal(planned.access.limit, 1);
});

test("residual predicates prevent unsafe scan-limit pushdown", () => {
  const planned = planQuery(
    schema,
    query(tasks)
      .where((task) => task.projectId.eq("project-1"))
      .where((task) => task.title.ne("Archived"))
      .limit(2)
      .many(),
  );

  assert.equal(planned.access.kind, "index-scan");
  assert.equal(planned.access.limit, undefined);
  assert.equal(planned.filters.length, 1);
  assert.equal(planned.limit, 2);
});

test("contradictory and disjunctive predicates remain available for filtering", () => {
  const contradictory = planQuery(
    schema,
    query(tasks)
      .where((task) => task.id.eq("task-1").and(task.id.eq("task-2")))
      .many(),
  );
  assert.equal(contradictory.access.kind, "primary-key");
  assert.deepEqual(contradictory.access.key, [
    { kind: "literal", value: "task-1" },
  ]);
  assert.equal(contradictory.filters.length, 1);

  const disjunction = planQuery(
    schema,
    query(tasks)
      .where((task) => task.id.eq("task-1").or(task.status.eq("open")))
      .many(),
  );
  assert.equal(disjunction.access.kind, "table-scan");
  assert.equal(disjunction.filters.length, 1);
});
