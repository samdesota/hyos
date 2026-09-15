import assert from "node:assert/strict";
import test from "node:test";

import { checkMigrationChain } from "@hyos/hydb/node";

import { agentMigrations } from "./migrations/index.js";
import { agentSchema } from "./model.js";

test("agent migrations remain valid immutable snapshots", () => {
  const check = checkMigrationChain(agentSchema, agentMigrations);

  assert.equal(check.error, undefined);
  assert.equal(check.ok, true);
  assert.deepEqual(check.issues, []);

  for (const migration of agentMigrations) {
    for (const step of migration.steps) {
      if (!("type" in step) || step.type !== "addTable") continue;

      assert.equal(
        Array.isArray((step.table as { columns?: unknown }).columns),
        true,
        `${migration.id} must capture a table description instead of importing the live model`,
      );
    }
  }
});

test("folder worktree default is introduced after the folder table", () => {
  const folderMigration = agentMigrations.find(
    (migration) => migration.id === "0010-agent-folder-state",
  );
  const worktreeMigration = agentMigrations.find(
    (migration) => migration.id === "0012-agent-folder-state-worktree-default",
  );

  assert.ok(folderMigration);
  assert.ok(worktreeMigration);

  const addFolder = folderMigration.steps.find(
    (step) => "type" in step && step.type === "addTable",
  );
  const addWorktreeDefault = worktreeMigration.steps.find(
    (step) => "type" in step && step.type === "addColumn",
  );

  assert.ok(addFolder && "description" in addFolder);
  assert.equal(
    addFolder.description.columns.some(
      (column) => column.name === "worktreeDefault",
    ),
    false,
  );
  assert.ok(addWorktreeDefault && "column" in addWorktreeDefault);
  assert.equal(addWorktreeDefault.column.name, "worktreeDefault");
});
