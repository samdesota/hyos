import {
  Check,
  ChevronDown,
  Command,
  Database,
  ListTodo,
  Sparkles,
  Zap,
} from "lucide-solid";
import { For } from "solid-js";

import type { ProjectView } from "../data.js";
import type { ActivityEntry } from "../ui-model.js";

export function Inspector(props: {
  project: ProjectView;
  projectCount: number;
  totalTasks: number;
  completedTasks: number;
  activities: readonly ActivityEntry[];
  runningCommand?: string;
}) {
  return (
    <aside class="inspector">
      <div class="inspector-heading">
        <div>
          <span class="pulse-dot" />
          <strong>Live inspector</strong>
        </div>
        <span>DDF</span>
      </div>
      <p class="inspector-intro">
        Every command below became weighted changes and settled into this nested
        board.
      </p>
      <div class="inspector-stats">
        <div>
          <Database size={16} />
          <span>
            <strong>{props.projectCount}</strong> projects
          </span>
        </div>
        <div>
          <ListTodo size={16} />
          <span>
            <strong>{props.totalTasks}</strong> nested tasks
          </span>
        </div>
        <div>
          <Check size={16} />
          <span>
            <strong>{props.completedTasks}</strong> completed
          </span>
        </div>
      </div>
      <div class="activity-heading">
        <span>Recent propagation</span>
        <small>{props.runningCommand ?? "settled"}</small>
      </div>
      <div class="activity-list">
        <For each={props.activities}>
          {(entry) => (
            <div class="activity-item">
              <span classList={{ query: entry.kind === "query" }}>
                {entry.kind === "query" ? (
                  <Zap size={13} />
                ) : (
                  <Command size={13} />
                )}
              </span>
              <div>
                <strong>{entry.title}</strong>
                <p>{entry.detail}</p>
              </div>
              <time>{entry.time}</time>
            </div>
          )}
        </For>
      </div>
      <details class="state-panel">
        <summary>
          Current nested result <ChevronDown size={14} />
        </summary>
        <pre>{JSON.stringify(props.project, null, 2)}</pre>
      </details>
      <div class="prototype-note">
        <Sparkles size={15} />
        <span>
          <strong>Policy synchronized</strong> — this browser only receives rows
          authorized for the selected principal.
        </span>
      </div>
    </aside>
  );
}
