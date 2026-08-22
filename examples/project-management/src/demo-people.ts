export const demoPeople = Object.freeze([
  { id: "user-maya", name: "Maya Chen", initials: "MC", color: "#7257d9" },
  { id: "user-jon", name: "Jon Bell", initials: "JB", color: "#e17055" },
  { id: "user-nia", name: "Nia Okafor", initials: "NO", color: "#008f72" },
  { id: "user-luca", name: "Luca Reyes", initials: "LR", color: "#2d7ff9" },
] as const);

export type DemoPerson = (typeof demoPeople)[number];

export function findDemoPerson(userId: string | undefined) {
  return demoPeople.find((person) => person.id === userId);
}

const initialProjects: Readonly<Record<string, string | undefined>> = {
  "user-maya": "project-hydb",
  "user-jon": "project-studio",
  "user-nia": "project-docs",
};

export function initialWorkspacePath(userId: string | undefined): string {
  if (userId === undefined) return "/login";
  const projectId = initialProjects[userId];
  return projectId === undefined ? "/projects" : `/projects/${projectId}`;
}
