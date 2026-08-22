import {
  storageMutation,
  type StorageDatabase,
  type StorageMutation,
} from "@hyos/hydb";

import { projects, tasks, users, type TaskStatus } from "./data.js";
import { demoPeople } from "./demo-people.js";

const seededProjects = [
  {
    id: "project-hydb",
    ownerId: "user-maya",
    name: "HyDB launch",
    description: "Ship the first fast, reactive local database experience.",
    color: "#6c5ce7",
    createdAt: new Date("2026-08-01T09:00:00Z"),
  },
  {
    id: "project-studio",
    ownerId: "user-jon",
    name: "Studio refresh",
    description: "A calmer visual system for the HyOS workspace.",
    color: "#e17055",
    createdAt: new Date("2026-08-05T09:00:00Z"),
  },
  {
    id: "project-docs",
    ownerId: "user-nia",
    name: "Developer docs",
    description: "Turn the prototype into a story developers can follow.",
    color: "#00a884",
    createdAt: new Date("2026-08-10T09:00:00Z"),
  },
] as const;

const taskTuples: ReadonlyArray<
  readonly [string, string, string | null, string, string, TaskStatus, number]
> = [
  [
    "ddf",
    "project-hydb",
    "user-maya",
    "Harden incremental joins",
    "Exercise re-keying and nested defaults.",
    "in_progress",
    4,
  ],
  [
    "commands",
    "project-hydb",
    "user-jon",
    "Design command ergonomics",
    "Keep tricky writes out of components.",
    "done",
    4,
  ],
  [
    "bench",
    "project-hydb",
    "user-nia",
    "Build browser benchmark",
    "Measure update propagation under load.",
    "backlog",
    3,
  ],
  [
    "storage",
    "project-hydb",
    "user-luca",
    "Prototype persistent adapter",
    "Map the storage seam onto the Node storage adapter.",
    "backlog",
    2,
  ],
  [
    "tokens",
    "project-studio",
    "user-maya",
    "Consolidate color tokens",
    "Reduce one-off values across surfaces.",
    "in_progress",
    3,
  ],
  [
    "nav",
    "project-studio",
    "user-luca",
    "Polish workspace navigation",
    "Improve density and active states.",
    "done",
    2,
  ],
  [
    "empty",
    "project-studio",
    null,
    "Design empty states",
    "Make new workspaces feel intentional.",
    "backlog",
    1,
  ],
  [
    "quickstart",
    "project-docs",
    "user-nia",
    "Write five-minute quickstart",
    "Schema to live query in one page.",
    "in_progress",
    4,
  ],
  [
    "commands-doc",
    "project-docs",
    "user-jon",
    "Document command handlers",
    "Explain Zod validation and atomicity.",
    "backlog",
    3,
  ],
  [
    "diagram",
    "project-docs",
    null,
    "Diagram the dataflow graph",
    "Show operators and weighted updates.",
    "backlog",
    2,
  ],
];

export async function seedStorage(storage: StorageDatabase): Promise<void> {
  const snapshot = await storage.snapshot();
  try {
    if (snapshot.sequence !== 0) return;

    const mutations: StorageMutation[] = [
      ...demoPeople.map((person) => storageMutation.insert(users, person)),
      ...seededProjects.map((project) =>
        storageMutation.insert(projects, project),
      ),
      ...taskTuples.map(
        (
          [id, projectId, assigneeId, title, description, status, priority],
          index,
        ) =>
          storageMutation.insert(tasks, {
            id,
            projectId,
            assigneeId,
            title,
            description,
            status,
            priority,
            createdAt: new Date(Date.UTC(2026, 7, 11 + index, 9, 0, 0)),
          }),
      ),
    ];
    await storage.commit({ expectedHead: snapshot.commit, mutations });
  } finally {
    await snapshot.close();
  }
}
