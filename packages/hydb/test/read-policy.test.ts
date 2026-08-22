import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  hydb,
  id,
  index,
  memoryStorage,
  storageMutation,
  text,
  type StorageDatabase,
  type StorageSnapshot,
} from "../src/index.js";

const projects = hydb.table("policy_projects", {
  id: id().primaryKey(),
  ownerId: id().notNull(),
  name: text().notNull(),
});

const tasks = hydb.table(
  "policy_tasks",
  {
    id: id().primaryKey(),
    projectId: id()
      .notNull()
      .references(() => projects.id),
    title: text().notNull(),
  },
  (columns) => [index("policy_tasks_project_idx").on(columns.projectId)],
);

const schema = hydb.schema({ projects, tasks });
const principal = z.object({ userId: z.string() });

function policies() {
  const policy = hydb.readPolicy(principal);
  return [
    policy.where(projects, ({ row, principal }) =>
      row.ownerId.eq(principal.userId),
    ),
    policy.through(tasks, projects, {
      from: tasks.projectId,
      to: projects.id,
    }),
  ];
}

function recordScans(
  storage: StorageDatabase,
  scans: string[],
): StorageDatabase {
  return {
    async snapshot(selector) {
      const snapshot = await storage.snapshot(selector);
      const recorded: StorageSnapshot = {
        commit: snapshot.commit,
        branch: snapshot.branch,
        sequence: snapshot.sequence,
        version: snapshot.version,
        get(table, key) {
          return snapshot.get(table, key);
        },
        scan(request) {
          scans.push(
            request.type === "table"
              ? `table:${request.table.id === projects.id ? "projects" : "tasks"}`
              : `index:${request.index}`,
          );
          return snapshot.scan(request);
        },
        close() {
          return snapshot.close();
        },
      };
      return recorded;
    },
    head(branch) {
      return storage.head(branch);
    },
    createBranch(request) {
      return storage.createBranch(request);
    },
    commit(request) {
      return storage.commit(request);
    },
    changes(options) {
      return storage.changes(options);
    },
    retain(request) {
      return storage.retain(request);
    },
    releaseRetention(name) {
      return storage.releaseRetention(name);
    },
    collectGarbage() {
      return storage.collectGarbage();
    },
    close() {
      return storage.close();
    },
  };
}

async function setup(options?: { scans?: string[] }) {
  const underlying = await memoryStorage({ schema });
  await underlying.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(projects, {
        id: "alice-project",
        ownerId: "alice",
        name: "Alice",
      }),
      storageMutation.insert(projects, {
        id: "bob-project",
        ownerId: "bob",
        name: "Bob",
      }),
      storageMutation.insert(tasks, {
        id: "alice-task",
        projectId: "alice-project",
        title: "Alice task",
      }),
      storageMutation.insert(tasks, {
        id: "bob-task",
        projectId: "bob-project",
        title: "Bob task",
      }),
    ],
  });
  const storage =
    options?.scans === undefined
      ? underlying
      : recordScans(underlying, options.scans);
  const database = await hydb.database({ schema, storage });
  const gateway = hydb.gateway({
    database,
    principal,
    commands: {},
    readPolicies: policies(),
  });
  return { database, gateway, storage };
}

test("row and relationship policies restrict direct gateway reads", async () => {
  const { database, gateway } = await setup();
  try {
    const alice = gateway.forPrincipal({ userId: "alice" });
    const bob = gateway.forPrincipal({ userId: "bob" });

    assert.deepEqual(await alice.fetch(hydb.query(projects).many()), [
      { id: "alice-project", ownerId: "alice", name: "Alice" },
    ]);
    assert.deepEqual(await alice.fetch(hydb.query(tasks).many()), [
      {
        id: "alice-task",
        projectId: "alice-project",
        title: "Alice task",
      },
    ]);
    assert.deepEqual(await bob.fetch(hydb.query(tasks).many()), [
      { id: "bob-task", projectId: "bob-project", title: "Bob task" },
    ]);
    assert.deepEqual(await bob.fetch(hydb.query(tasks).limit(1).many()), [
      { id: "bob-task", projectId: "bob-project", title: "Bob task" },
    ]);
  } finally {
    await database.close();
  }
});

test("an authorized outer project proves its nested task policy", async () => {
  const scans: string[] = [];
  const { database, gateway } = await setup({ scans });
  try {
    const query = hydb
      .query(projects)
      .select((project) => ({
        id: project.id,
        tasks: hydb
          .query(tasks)
          .where((task) => task.projectId.eq(project.id))
          .many(),
      }))
      .many();

    assert.deepEqual(
      await gateway.forPrincipal({ userId: "alice" }).fetch(query),
      [
        {
          id: "alice-project",
          tasks: [
            {
              id: "alice-task",
              projectId: "alice-project",
              title: "Alice task",
            },
          ],
        },
      ],
    );
    assert.equal(scans.filter((scan) => scan === "table:projects").length, 1);
    assert.equal(
      scans.filter((scan) => scan === "index:policy_tasks_project_idx").length,
      1,
    );
  } finally {
    await database.close();
  }
});

test("relationship-policy changes revoke synchronized child rows", async () => {
  const { database, gateway, storage } = await setup();
  try {
    const results: unknown[] = [];
    let resolveInitial!: () => void;
    let resolveRevoked!: () => void;
    const initial = new Promise<void>((resolve) => {
      resolveInitial = resolve;
    });
    const revoked = new Promise<void>((resolve) => {
      resolveRevoked = resolve;
    });
    const unsubscribe = gateway
      .forPrincipal({ userId: "alice" })
      .subscribe(hydb.query(tasks).many(), (result) => {
        results.push(result);
        if (results.length === 1) resolveInitial();
        if (results.length === 2) resolveRevoked();
      });

    await initial;
    const head = await storage.head();
    await storage.commit({
      expectedHead: head,
      mutations: [
        storageMutation.update(projects, ["alice-project"], {
          id: "alice-project",
          ownerId: "bob",
          name: "Alice",
        }),
      ],
    });
    await revoked;
    unsubscribe();

    assert.deepEqual(results, [
      [
        {
          id: "alice-task",
          projectId: "alice-project",
          title: "Alice task",
        },
      ],
      [],
    ]);
  } finally {
    await database.close();
  }
});

test("gateway construction fails closed when any table lacks a policy", async () => {
  const storage = await memoryStorage({ schema });
  const database = await hydb.database({ schema, storage });
  try {
    const policy = hydb.readPolicy(principal);
    assert.throws(
      () =>
        hydb.gateway({
          database,
          principal,
          commands: {},
          readPolicies: [policy.allowAll(projects)],
        }),
      /Missing read policy for table: policy_tasks/,
    );
  } finally {
    await database.close();
  }
});

test("read policies are bound to the gateway principal schema", async () => {
  const storage = await memoryStorage({ schema });
  const database = await hydb.database({ schema, storage });
  try {
    const otherPrincipal = z.object({ userId: z.string() });
    const policy = hydb.readPolicy(otherPrincipal);
    assert.throws(
      () =>
        hydb.gateway({
          database,
          principal,
          commands: {},
          readPolicies: [policy.allowAll(projects), policy.allowAll(tasks)],
        }),
      /Read policies must use the gateway's principal schema/,
    );
  } finally {
    await database.close();
  }
});

test("denyAll is an explicit empty read policy", async () => {
  const storage = await memoryStorage({ schema });
  await storage.commit({
    expectedVersion: 0,
    mutations: [
      storageMutation.insert(projects, {
        id: "hidden",
        ownerId: "alice",
        name: "Hidden",
      }),
    ],
  });
  const database = await hydb.database({ schema, storage });
  try {
    const policy = hydb.readPolicy(principal);
    const gateway = hydb.gateway({
      database,
      principal,
      commands: {},
      readPolicies: [policy.denyAll(projects), policy.denyAll(tasks)],
    });
    assert.deepEqual(
      await gateway
        .forPrincipal({ userId: "alice" })
        .fetch(hydb.query(projects).many()),
      [],
    );
  } finally {
    await database.close();
  }
});
