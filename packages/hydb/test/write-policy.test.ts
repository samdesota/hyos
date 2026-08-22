import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  AuthorizationError,
  hydb,
  id,
  memoryStorage,
  storageMutation,
  text,
} from "../src/index.js";

const principal = z.object({ userId: z.string() });
const projects = hydb.table("write_policy_projects", {
  id: id().primaryKey(),
  ownerId: id().notNull(),
});
const tasks = hydb.table("write_policy_tasks", {
  id: id().primaryKey(),
  projectId: id().notNull(),
  title: text().notNull(),
});
const schema = hydb.schema({ projects, tasks });

async function setup() {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(projects, {
        id: "alice-project",
        ownerId: "alice",
      }),
      storageMutation.insert(projects, {
        id: "bob-project",
        ownerId: "bob",
      }),
      storageMutation.insert(tasks, {
        id: "task",
        projectId: "alice-project",
        title: "Before",
      }),
    ],
  });
  return hydb.database({ schema, storage });
}

test("write policies are individual fail-closed values", async () => {
  const database = await setup();
  const policies = hydb.writePolicy(principal);
  const defaultPolicy = [
    policies.where(projects, async ({ change, principal, db }) => {
      const row = change.kind === "insert" ? change.after : change.before;
      const current = await db.get(projects, [row.id]);
      return (current ?? row).ownerId === principal.userId;
    }),
    policies.through(tasks, projects, {
      from: tasks.projectId,
      to: projects.id,
    }),
  ];

  try {
    await database.transact(
      {
        principalSchema: principal,
        principal: { userId: "alice" },
        defaultPolicy,
      },
      (transaction) =>
        transaction.update(tasks, ["task"], { title: "Allowed" }),
    );

    await assert.rejects(
      database.transact(
        {
          principalSchema: principal,
          principal: { userId: "bob" },
          defaultPolicy,
        },
        (transaction) =>
          transaction.update(tasks, ["task"], { title: "Denied" }),
      ),
      AuthorizationError,
    );

    assert.deepEqual(await database.fetch(hydb.query(tasks).many()), [
      { id: "task", projectId: "alice-project", title: "Allowed" },
    ]);
  } finally {
    await database.close();
  }
});

test("admin policy scopes require a successful, messaged assertion", async () => {
  const database = await setup();
  const policies = hydb.writePolicy(principal);
  const defaultPolicy = [policies.allowAll(projects), policies.denyAll(tasks)];

  try {
    await database.transact(
      {
        principalSchema: principal,
        principal: { userId: "alice" },
        defaultPolicy,
      },
      (transaction) =>
        transaction.withAdminPolicy(async ({ db, assert: authorize }) => {
          const project = await db.get(projects, ["alice-project"]);
          authorize(
            project?.ownerId === "alice",
            "Only the project owner may update its tasks",
          );
          await transaction.update(tasks, ["task"], { title: "Admin" });
        }),
    );

    await assert.rejects(
      database.transact(
        {
          principalSchema: principal,
          principal: { userId: "alice" },
          defaultPolicy,
        },
        (transaction) =>
          transaction.withAdminPolicy(() =>
            transaction.update(tasks, ["task"], { title: "Unarmed" }),
          ),
      ),
      /Admin policy must be asserted before performing a mutation/,
    );

    await assert.rejects(
      database.transact(
        {
          principalSchema: principal,
          principal: { userId: "alice" },
          defaultPolicy,
        },
        (transaction) =>
          transaction.withAdminPolicy(({ assert: authorize }) => {
            authorize(false, "Project ownership is required");
          }),
      ),
      /Project ownership is required/,
    );

    await assert.rejects(
      database.transact(
        {
          principalSchema: principal,
          principal: { userId: "alice" },
          defaultPolicy,
        },
        (transaction) =>
          transaction.withAdminPolicy(({ assert: authorize }) => {
            authorize(true, "   ");
          }),
      ),
      /meaningful error message/,
    );
  } finally {
    await database.close();
  }
});

test("write policy sets reject missing and mismatched policies", async () => {
  const database = await setup();
  const policies = hydb.writePolicy(principal);
  const otherPrincipal = z.object({ userId: z.string() });
  const otherPolicies = hydb.writePolicy(otherPrincipal);

  try {
    assert.throws(
      () =>
        database.transact(
          {
            principalSchema: principal,
            principal: { userId: "alice" },
            defaultPolicy: [policies.allowAll(projects)],
          },
          () => undefined,
        ),
      /Missing write policy for table: write_policy_tasks/,
    );

    assert.throws(
      () =>
        database.transact(
          {
            principalSchema: principal,
            principal: { userId: "alice" },
            defaultPolicy: [
              policies.allowAll(projects),
              otherPolicies.allowAll(tasks),
            ],
          },
          () => undefined,
        ),
      /principal schema/,
    );
  } finally {
    await database.close();
  }
});
