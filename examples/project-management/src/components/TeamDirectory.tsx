import { CheckCircle2, ListTodo, Users } from "lucide-solid";
import { For, Show } from "solid-js";

import type { Team } from "../data.js";

export type TeamMemberSummary = Readonly<{
  member: Team[number];
  assigned: number;
  completed: number;
  projectCount: number;
  current: boolean;
}>;

export function TeamDirectory(props: {
  members: readonly TeamMemberSummary[];
}) {
  const assigned = () =>
    props.members.reduce((sum, item) => sum + item.assigned, 0);
  return (
    <section class="collection-page">
      <header class="collection-header">
        <div class="collection-title">
          <span class="collection-icon green">
            <Users size={20} />
          </span>
          <div>
            <span class="eyebrow">Readable directory</span>
            <h1>Team</h1>
          </div>
        </div>
        <p>
          People visible to this principal, with workloads calculated only from
          authorized projects.
        </p>
        <div class="collection-metrics">
          <span>
            <Users size={15} />
            <strong>{props.members.length}</strong> people
          </span>
          <span>
            <ListTodo size={15} />
            <strong>{assigned()}</strong> visible assignments
          </span>
        </div>
      </header>

      <div class="team-grid">
        <For each={props.members}>
          {({ member, assigned, completed, projectCount, current }) => (
            <article class="team-card" data-testid={`team-member-${member.id}`}>
              <div class="team-card-person">
                <span
                  class="avatar large"
                  style={{ "background-color": member.color }}
                >
                  {member.initials}
                </span>
                <div>
                  <h2>{member.name}</h2>
                  <p>{current ? "Current identity" : "Workspace member"}</p>
                </div>
                <Show when={current}>
                  <span class="you-badge">You</span>
                </Show>
              </div>
              <div class="team-card-stats">
                <span>
                  <ListTodo size={14} />
                  <strong>{assigned}</strong>
                  {assigned === 1 ? " assigned task" : " assigned tasks"}
                </span>
                <span>
                  <CheckCircle2 size={14} />
                  <strong>{completed}</strong> completed
                </span>
              </div>
              <footer>
                {projectCount === 1
                  ? "1 authorized project"
                  : `${projectCount} authorized projects`}
              </footer>
            </article>
          )}
        </For>
      </div>
    </section>
  );
}
