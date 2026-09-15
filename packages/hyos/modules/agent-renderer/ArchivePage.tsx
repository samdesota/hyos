import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import type { AgentSessionSummary } from "../../capabilities/agent.js";

export type ArchivePageProps = Readonly<{
  /** Back navigation — returns to the view that opened the page. */
  onBack: () => void;
  /** All archived sessions, in any order; the page sorts and filters them. */
  sessions: readonly AgentSessionSummary[];
}>;

/** Newest archive time first; sessions without a timestamp fall back to
 * `updatedAt`, and ties keep the caller's order (stable sort). */
const byArchivedDesc = (
  a: AgentSessionSummary,
  b: AgentSessionSummary,
): number =>
  (b.archivedAt ?? b.updatedAt).getTime() -
  (a.archivedAt ?? a.updatedAt).getTime();

/**
 * The `/archive` route: a header with a back button, a title search bar, and
 * the archived sessions listed newest-archived first, filtered by the query.
 */
export const ArchivePage: Component<ArchivePageProps> = (props) => {
  const [query, setQuery] = createSignal("");
  let searchInput: HTMLInputElement | undefined;

  const visible = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const archived = [...props.sessions].sort(byArchivedDesc);
    if (!needle) return archived;
    return archived.filter((session) =>
      session.title.toLowerCase().includes(needle),
    );
  });

  return (
    <section class="archive-page">
      <header class="archive-header">
        <button
          type="button"
          class="archive-back"
          aria-label="Back"
          title="Back"
          onClick={() => props.onBack()}
        >
          ←
        </button>
        <h2 class="archive-title">Archived sessions</h2>
        <input
          ref={searchInput}
          class="archive-search"
          type="search"
          placeholder="Search archived sessions"
          aria-label="Search archived sessions"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </header>
      <div class="archive-body">
        <Show
          when={visible().length > 0}
          fallback={
            <div class="archive-empty">
              {query().trim()
                ? "No archived sessions match your search"
                : "No archived sessions"}
            </div>
          }
        >
          <ul class="archive-list">
            <For each={visible()}>
              {(session) => (
                <li class="archive-row">
                  <span class="archive-row-title">{session.title}</span>
                  <span class="archive-row-folder">{session.folder}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </section>
  );
};
