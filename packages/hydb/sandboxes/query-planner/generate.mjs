import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hydb,
  id,
  index,
  integer,
  planQuery,
  text,
  uniqueIndex,
} from "../../dist/src/index.js";
import { getQueryPlan } from "../../dist/src/query.js";
import { getTableDefinition } from "../../dist/src/schema.js";
import { renderSandbox } from "../render-sandbox.mjs";

const projects = hydb.table(
  "projects",
  {
    id: id().primaryKey(),
    slug: text().notNull(),
    name: text().notNull(),
  },
  (columns) => [uniqueIndex("projects_slug_idx").on(columns.slug)],
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

const definitions = [
  {
    id: "primary-key",
    label: "Primary-key lookup",
    summary: "One equality becomes a direct get",
    description:
      "The primary-key predicate is fully consumed by the storage access path, so no residual filter remains.",
    source: `hydb.query(tasks)
  .where((task) => task.id.eq("task-42"))
  .require()`,
    query: hydb
      .query(tasks)
      .where((task) => task.id.eq("task-42"))
      .require(),
  },
  {
    id: "composite-index",
    label: "Composite index",
    summary: "Filter, order, and limit all push down",
    description:
      "Two equality predicates form an index prefix; the next index column supplies ordering and makes the limit safe to push into the scan.",
    source: `hydb.query(tasks)
  .where((task) => task.projectId.eq("project-7"))
  .where((task) => task.status.eq("open"))
  .orderBy((task) => task.position.asc())
  .limit(20)
  .many()`,
    query: hydb
      .query(tasks)
      .where((task) => task.projectId.eq("project-7"))
      .where((task) => task.status.eq("open"))
      .orderBy((task) => task.position.asc())
      .limit(20)
      .many(),
  },
  {
    id: "residual-filter",
    label: "Residual filter",
    summary: "An index narrows rows, then JS filters",
    description:
      "The project equality selects an index, but title inequality remains above the scan. The limit cannot move below that residual filter.",
    source: `hydb.query(tasks)
  .where((task) => task.projectId.eq("project-7"))
  .where((task) => task.title.ne("Archived"))
  .limit(5)
  .many()`,
    query: hydb
      .query(tasks)
      .where((task) => task.projectId.eq("project-7"))
      .where((task) => task.title.ne("Archived"))
      .limit(5)
      .many(),
  },
  {
    id: "ordering-index",
    label: "Ordering-only index",
    summary: "A reverse index scan avoids sorting",
    description:
      "No predicate is searchable, but the status index already has the requested order and can be scanned backward with a bounded limit.",
    source: `hydb.query(tasks)
  .orderBy((task) => task.status.desc())
  .limit(5)
  .many()`,
    query: hydb
      .query(tasks)
      .orderBy((task) => task.status.desc())
      .limit(5)
      .many(),
  },
  {
    id: "nested-query",
    label: "Correlated nesting",
    summary: "A parent field becomes an outer binding",
    description:
      "The nested tasks query retains its correlation to projects.id and plans an ordered child-index lookup for each parent key.",
    source: `hydb.query(projects)
  .select((project) => ({
    id: project.id,
    name: project.name,
    tasks: hydb.query(tasks)
      .where((task) => task.projectId.eq(project.id))
      .orderBy((task) => task.position.asc())
      .many(),
  }))
  .many()`,
    query: hydb
      .query(projects)
      .select((project) => ({
        id: project.id,
        name: project.name,
        tasks: hydb
          .query(tasks)
          .where((task) => task.projectId.eq(project.id))
          .orderBy((task) => task.position.asc())
          .many(),
      }))
      .many(),
  },
  {
    id: "or-fallback",
    label: "Disjunction fallback",
    summary: "OR stays as a residual predicate",
    description:
      "The initial planner does not split OR branches, so the complete expression remains visible above a table scan for correctness.",
    source: `hydb.query(tasks)
  .where((task) =>
    task.id.eq("task-42").or(task.status.eq("blocked")),
  )
  .many()`,
    query: hydb
      .query(tasks)
      .where((task) => task.id.eq("task-42").or(task.status.eq("blocked")))
      .many(),
  },
];

function createSourceLabels() {
  const labels = new Map();
  return (source) => {
    let label = labels.get(source);
    if (label === undefined) {
      label = `${source.table}#${labels.size + 1}`;
      labels.set(source, label);
    }
    return label;
  };
}

function expressionJson(node, sourceLabel) {
  switch (node.type) {
    case "field":
      return {
        type: "field",
        source: sourceLabel(node.source),
        column: node.column,
      };
    case "literal":
      return { type: "literal", value: node.value };
    case "comparison":
    case "logical":
      return {
        type: node.type,
        operator: node.operator,
        left: expressionJson(node.left, sourceLabel),
        right: expressionJson(node.right, sourceLabel),
      };
    case "not":
      return { type: "not", value: expressionJson(node.value, sourceLabel) };
  }
}

function isLogicalQuery(value) {
  return typeof value === "object" && value !== null && "filters" in value;
}

function logicalJson(plan, sourceLabel) {
  return {
    source: sourceLabel(plan.source),
    filters: plan.filters.map((filter) => expressionJson(filter, sourceLabel)),
    order: plan.order.map((item) => ({
      expression: expressionJson(item.expression, sourceLabel),
      direction: item.direction,
    })),
    ...(plan.limit === undefined ? {} : { limit: plan.limit }),
    ...(plan.selection === undefined
      ? {}
      : {
          selection: Object.fromEntries(
            Object.entries(plan.selection).map(([name, value]) => [
              name,
              isLogicalQuery(value)
                ? logicalJson(value, sourceLabel)
                : expressionJson(value, sourceLabel),
            ]),
          ),
        }),
    cardinality: plan.cardinality,
  };
}

function plannedValueJson(value, sourceLabel) {
  return value.kind === "literal"
    ? { kind: "literal", value: value.value }
    : {
        kind: "outer-field",
        source: sourceLabel(value.source),
        column: value.column,
      };
}

function physicalJson(plan, sourceLabel) {
  const access = {
    kind: plan.access.kind,
    table: getTableDefinition(plan.access.table).name,
    ...(plan.access.kind === "primary-key"
      ? {
          key: plan.access.key.map((value) =>
            plannedValueJson(value, sourceLabel),
          ),
        }
      : {
          ...(plan.access.kind === "index-scan"
            ? {
                index: plan.access.index,
                key: plan.access.key.map((value) =>
                  plannedValueJson(value, sourceLabel),
                ),
              }
            : {}),
          reverse: plan.access.reverse,
          ...(plan.access.limit === undefined
            ? {}
            : { limit: plan.access.limit }),
        }),
  };
  return {
    access,
    filters: plan.filters.map((filter) => expressionJson(filter, sourceLabel)),
    order: plan.order.map((item) => ({
      expression: expressionJson(item.expression, sourceLabel),
      direction: item.direction,
    })),
    ...(plan.limit === undefined ? {} : { limit: plan.limit }),
    cardinality: plan.cardinality,
    ...(plan.selection === undefined
      ? {}
      : {
          selection: Object.fromEntries(
            Object.entries(plan.selection).map(([name, value]) => [
              name,
              value.kind === "query"
                ? { kind: "query", plan: physicalJson(value.plan, sourceLabel) }
                : {
                    kind: "expression",
                    expression: expressionJson(value.expression, sourceLabel),
                  },
            ]),
          ),
        }),
  };
}

function accessLabel(plan) {
  if (plan.access.kind === "primary-key") return "primary get";
  if (plan.access.kind === "table-scan") return "table scan";
  return `index · ${plan.access.index}`;
}

function physicalDecision(plan) {
  const residual = plan.filters.length;
  const order = plan.order.length;
  const pushedLimit = "limit" in plan.access ? plan.access.limit : undefined;
  return `${accessLabel(plan)} selected; ${residual} residual filter${residual === 1 ? "" : "s"}; ${order} remaining sort key${order === 1 ? "" : "s"}; ${pushedLimit === undefined ? "no scan limit" : `scan limit ${pushedLimit}`}.`;
}

function physicalGraph(plan, sourceLabel) {
  const nodes = [];
  let sequence = 0;

  function addNode(kind, label, summary, details, children = []) {
    const id = `node-${++sequence}`;
    nodes.push({ id, kind, label, summary, details, children });
    return id;
  }

  function outerBindings(access) {
    return "key" in access
      ? access.key
          .filter((value) => value.kind === "outer-field")
          .map((value) => plannedValueJson(value, sourceLabel))
      : [];
  }

  function buildPlan(currentPlan, upstream, dependentField) {
    const serialized = physicalJson(currentPlan, sourceLabel);
    const access = currentPlan.access;
    let current = addNode(
      "storage",
      access.kind === "primary-key"
        ? "Primary-key lookup"
        : access.kind === "index-scan"
          ? "Index scan"
          : "Table scan",
      access.kind === "index-scan"
        ? `${getTableDefinition(access.table).name} via ${access.index}${upstream === undefined ? "" : " · once per outer row"}`
        : getTableDefinition(access.table).name,
      {
        ...serialized.access,
        execution:
          upstream === undefined
            ? "Starts this row stream"
            : "Waits for an outer row, resolves its bound key, then runs",
      },
      upstream === undefined
        ? []
        : [{ id: upstream, label: "bound key", kind: "dependency" }],
    );

    if (currentPlan.filters.length > 0) {
      current = addNode(
        "operator",
        "Residual filter",
        `${currentPlan.filters.length} predicate${currentPlan.filters.length === 1 ? "" : "s"} evaluated after storage`,
        { predicates: serialized.filters },
        [{ id: current, label: "rows", kind: "data" }],
      );
    }

    if (currentPlan.order.length > 0) {
      current = addNode(
        "operator",
        "In-memory sort",
        `${currentPlan.order.length} ordering key${currentPlan.order.length === 1 ? "" : "s"} not supplied by storage`,
        { order: serialized.order },
        [{ id: current, label: "rows", kind: "data" }],
      );
    }

    if (currentPlan.limit !== undefined) {
      current = addNode(
        "operator",
        "Limit",
        `Return at most ${currentPlan.limit} rows`,
        {
          count: currentPlan.limit,
          pushedIntoStorage:
            "limit" in access && access.limit === currentPlan.limit,
        },
        [{ id: current, label: "rows", kind: "data" }],
      );
    }

    if (currentPlan.selection !== undefined) {
      const fields = [];
      for (const [name, value] of Object.entries(currentPlan.selection)) {
        if (value.kind === "query") {
          const bindings = outerBindings(value.plan.access);
          current = addNode(
            "control",
            "Correlated apply",
            `For each outer row, bind ${bindings.map((binding) => `${binding.source}.${binding.column}`).join(", ")} and run ${name}`,
            {
              nestedField: name,
              execution:
                "The outer row must arrive before the child lookup starts",
              bindings,
            },
            [{ id: current, label: "outer row", kind: "data" }],
          );
          current = buildPlan(value.plan, current, name);
          fields.push({ name, kind: "nested-query" });
        } else {
          fields.push({
            name,
            kind: "expression",
            expression: expressionJson(value.expression, sourceLabel),
          });
        }
      }
      current = addNode(
        "operator",
        "Projection & nesting",
        `${fields.length} selected field${fields.length === 1 ? "" : "s"}`,
        { fields },
        [{ id: current, label: "complete row", kind: "data" }],
      );
    }

    const resultLabel = {
      many: "Materialize list",
      one: "Return one or null",
      require: "Require one row",
      exists: "Check existence",
      count: "Count rows",
    }[currentPlan.cardinality];
    return addNode(
      "result",
      dependentField === undefined
        ? resultLabel
        : `Materialize ${dependentField}`,
      dependentField === undefined
        ? `Cardinality: ${currentPlan.cardinality}`
        : `Build the nested ${dependentField} value, then continue the outer row`,
      {
        cardinality: currentPlan.cardinality,
        ...(dependentField === undefined
          ? {}
          : { nestedField: dependentField, returnsToOuterRow: true }),
      },
      [{ id: current, label: "rows", kind: "data" }],
    );
  }

  const root = buildPlan(plan);
  return { root, nodes };
}

const scenarios = definitions.map((definition) => {
  const logical = getQueryPlan(definition.query);
  const physical = planQuery(schema, definition.query);
  const sourceLabel = createSourceLabels();
  return {
    id: definition.id,
    label: definition.label,
    summary: definition.summary,
    description: definition.description,
    access: accessLabel(physical),
    stages: [
      {
        label: "TypeScript builder",
        language: "TypeScript",
        description:
          "The immutable, typed query expression authored by an application developer.",
        content: definition.source,
        decision:
          "The builder captures intent and result types; it performs no storage access.",
      },
      {
        label: "Logical query AST",
        language: "JSON",
        description:
          "The real query builder's immutable JSON-shaped representation before storage choices.",
        content: JSON.stringify(logicalJson(logical, sourceLabel), null, 2),
        decision:
          "Callbacks and fluent methods have become source-aware expressions, ordering, cardinality, and nested query nodes.",
      },
      {
        label: "Physical execution plan",
        language: "Operator graph",
        description:
          "The real planner output as clickable execution nodes. Select any node to inspect the exact attributes that produced it.",
        view: "graph",
        graph: physicalGraph(physical, sourceLabel),
        decision: physicalDecision(physical),
      },
    ],
  };
});

const html = renderSandbox({
  title: "How HyDB plans a query",
  question:
    "How does a typed builder expression become a storage-aware plan, and which parts can safely move into a B+ tree access path? Choose a scenario, then walk through its three representations.",
  scenarios,
});

const currentDirectory = dirname(fileURLToPath(import.meta.url));
await mkdir(currentDirectory, { recursive: true });
await writeFile(join(currentDirectory, "index.html"), html);
console.log(
  `Generated ${definitions.length} planner scenarios at sandboxes/query-planner/index.html`,
);
