import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import type { AgentSessionSummary } from "../../capabilities/agent.js";

export type ArchivePageProps = Readonly<{
  /** All archived sessions, in any order; the page sorts, groups, and filters them. */
  sessions: readonly AgentSessionSummary[];
  /** Open a session in place — it stays archived. */
  onOpen: (sessionId: string) => void;
  /** Unarchive a session (removes it from this list). */
  onUnarchive: (sessionId: string) => void;
}>;

/** Newest archive time first; sessions without a timestamp fall back to
 * `updatedAt`, and ties keep the caller's order (stable sort). */
const byArchivedDesc = (
  a: AgentSessionSummary,
  b: AgentSessionSummary,
): number =>
  (b.archivedAt ?? b.updatedAt).getTime() -
  (a.archivedAt ?? a.updatedAt).getTime();

/** Start of the local day containing `time`, shifted by `days`. */
const startOfDay = (time: number, daysAgo = 0): number => {
  const date = new Date(time);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** Time-ordered archive buckets with their display headers. */
const BUCKETS: readonly { label: string; from: (now: number) => number }[] = [
  { label: "Today", from: (now) => startOfDay(now) },
  { label: "Yesterday", from: (now) => startOfDay(now, 1) },
  { label: "Last 7 days", from: (now) => startOfDay(now, 7) },
  { label: "Last month", from: (now) => startOfDay(now, 30) },
  { label: "Older", from: () => Number.NEGATIVE_INFINITY },
];

type ArchiveGroup = Readonly<{
  label: string;
  sessions: readonly AgentSessionSummary[];
}>;

/** Group newest-first sessions into Today / Yesterday / Last 7 days /
 * Last month / Older buckets; empty buckets are dropped. */
function groupByRecency(
  sessions: readonly AgentSessionSummary[],
): readonly ArchiveGroup[] {
  const now = Date.now();
  const buckets = BUCKETS.map(() => [] as AgentSessionSummary[]);
  for (const session of sessions) {
    const time = (session.archivedAt ?? session.updatedAt).getTime();
    const index = BUCKETS.findIndex((bucket) => time >= bucket.from(now));
    buckets[index === -1 ? buckets.length - 1 : index].push(session);
  }
  return BUCKETS.map((bucket, index) => ({
    label: bucket.label,
    sessions: buckets[index],
  })).filter((group) => group.sessions.length > 0);
}

/** Rows rendered before the lazy-load sentinel fetches more. */
const PAGE_SIZE = 50;

/**
 * The `/archive` route: a centered title with a search bar beneath it, and
 * the archived sessions listed newest-archived first under recency headers
 * (Today, Yesterday, Last 7 days, Last month, Older). Rows render lazily in
 * pages as the list is scrolled.
 */
export const ArchivePage: Component<ArchivePageProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [renderLimit, setRenderLimit] = createSignal(PAGE_SIZE);
  let searchInput: HTMLInputElement | undefined;
  let sentinel: HTMLDivElement | undefined;

  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const archived = [...props.sessions].sort(byArchivedDesc);
    if (!needle) return archived;
    return archived.filter((session) =>
      session.title.toLowerCase().includes(needle),
    );
  });

  const groups = createMemo(() => groupByRecency(matches()));

  /** Flat row stream (groups are header-delimited) driving pagination. */
  const flat = createMemo(() => groups().flatMap((group) => group.sessions));

  onMount(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          renderLimit() < flat().length
        ) {
          setRenderLimit((limit) => limit + PAGE_SIZE);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel!);
    onCleanup(() => observer.disconnect());
  });

  /** Groups truncated to the current lazy-render page, so row rendering is
   * a pure function of the limit (no render-order bookkeeping). */
  const visibleGroups = createMemo(() => {
    const limit = renderLimit();
    const visible: ArchiveGroup[] = [];
    let used = 0;
    for (const group of groups()) {
      if (used >= limit) break;
      const sessions = group.sessions.slice(0, limit - used);
      used += sessions.length;
      visible.push({ label: group.label, sessions });
    }
    return visible;
  });

  return (
    <section class="archive-page">
      <div class="archive-column">
        <header class="archive-header">
          <h2 class="archive-title">Archived sessions</h2>
          <input
            ref={searchInput}
            class="archive-search"
            type="search"
            placeholder="Search archived sessions"
            aria-label="Search archived sessions"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setRenderLimit(PAGE_SIZE);
            }}
          />
        </header>
        <div class="archive-body">
          <Show
            when={flat().length > 0}
            fallback={
              <div class="archive-empty">
                {query().trim()
                  ? "No archived sessions match your search"
                  : "No archived sessions"}
              </div>
            }
          >
            <For each={visibleGroups()}>
              {(group) => (
                <section class="archive-group">
                  <h3 class="archive-group-label">{group.label}</h3>
                  <ul class="archive-list">
                    <For each={group.sessions}>
                      {(session) => (
                        <li class="archive-row">
                          <button
                            type="button"
                            class="archive-row-open"
                            title={`Open "${session.title}"`}
                            onClick={() => props.onOpen(session.id)}
                          >
                            <span class="archive-row-title">
                              {session.title}
                            </span>
                            <span class="archive-row-folder">
                              {session.folder}
                            </span>
                          </button>
                          <button
                            type="button"
                            class="archive-row-unarchive"
                            aria-label={`Unarchive "${session.title}"`}
                            title="Unarchive session"
                            onClick={() => props.onUnarchive(session.id)}
                          >
                            ↩
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
            <div
              ref={sentinel}
              class="archive-sentinel"
              aria-hidden="true"
              data-done={renderLimit() >= flat().length}
            />
          </Show>
        </div>
      </div>
    </section>
  );
};
