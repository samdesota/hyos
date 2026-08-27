import { createCommandDispatcher, createGatewayQuery } from "@hyos/hyapp/solid";
import { Badge, Button, IconButton } from "@hyos/components";
import { micromark } from "micromark";
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";

import { noteTimelineQuery, type NoteTimeline } from "./application.js";
import { client } from "./client.js";
import { InlineNoteEditor } from "./components/InlineNoteEditor";
import { NoteComposer, type NoteDraft } from "./components/NoteComposer";

export function App() {
  const timeline = createGatewayQuery(client, noteTimelineQuery);
  const dispatch = createCommandDispatcher(client);
  const [selectedMonth, setSelectedMonth] = createSignal<string>();
  const [selectedTag, setSelectedTag] = createSignal<string>();
  const [deletingNoteId, setDeletingNoteId] = createSignal<string>();
  const [deleteError, setDeleteError] = createSignal<string>();
  const [editingNoteId, setEditingNoteId] = createSignal<string>();

  const monthOptions = createMemo(() => {
    const counts = new Map<string, number>();
    for (const note of timeline.data() ?? []) {
      const key = monthKey(note.createdAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([key, count]) => ({ key, count, label: formatMonth(key) }));
  });

  const tagOptions = createMemo(() => {
    const counts = new Map<string, number>();
    for (const note of timeline.data() ?? []) {
      for (const tag of note.tags) {
        counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => ({ name, count }));
  });

  const filteredNotes = createMemo(() => {
    const month = selectedMonth();
    const tag = selectedTag();
    return (timeline.data() ?? []).filter(
      (note) =>
        (month === undefined || monthKey(note.createdAt) === month) &&
        (tag === undefined || note.tags.some((value) => value.name === tag)),
    );
  });

  async function captureNote(draft: NoteDraft) {
    const now = new Date();
    await dispatch("createNote", {
      id: crypto.randomUUID(),
      title: draft.title ?? null,
      content: draft.content,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  async function removeNote(id: string) {
    if (!window.confirm("Delete this note? This cannot be undone.")) return;

    setDeletingNoteId(id);
    setDeleteError(undefined);
    try {
      await dispatch("deleteNote", { id });
    } catch (cause) {
      setDeleteError(
        cause instanceof Error ? cause.message : "Could not delete note",
      );
    } finally {
      setDeletingNoteId(undefined);
    }
  }

  async function reviseNote(id: string, draft: NoteDraft) {
    await dispatch("updateNote", {
      id,
      title: draft.title ?? null,
      content: draft.content,
      updatedAt: new Date(),
    });
    setEditingNoteId(undefined);
  }

  return (
    <main class="app-shell">
      <div class="app-header">
        <a class="wordmark" href="/" aria-label="hy-notes home">
          hy<span>/</span>notes
        </a>
        <p>Capture now. Find it later.</p>
      </div>

      <div class="notes-layout">
        <aside class="notes-sidebar" aria-label="Timeline filters">
          <FilterSection title="Months">
            <FilterButton
              label="All notes"
              count={(timeline.data() ?? []).length}
              selected={selectedMonth() === undefined}
              onSelect={() => setSelectedMonth(undefined)}
            />
            <For each={monthOptions()}>
              {(month) => (
                <FilterButton
                  label={month.label}
                  count={month.count}
                  selected={selectedMonth() === month.key}
                  onSelect={() => setSelectedMonth(month.key)}
                />
              )}
            </For>
          </FilterSection>

          <FilterSection title="Tags">
            <FilterButton
              label="All tags"
              count={tagOptions().length}
              selected={selectedTag() === undefined}
              onSelect={() => setSelectedTag(undefined)}
            />
            <For
              each={tagOptions()}
              fallback={<p class="filter-empty">No tags yet</p>}
            >
              {(tag) => (
                <FilterButton
                  label={`#${tag.name}`}
                  count={tag.count}
                  selected={selectedTag() === tag.name}
                  onSelect={() => setSelectedTag(tag.name)}
                />
              )}
            </For>
          </FilterSection>
        </aside>

        <div class="notes-content">
          <NoteComposer onSubmit={captureNote} />
          <Timeline
            loading={timeline.loading()}
            error={timeline.error()}
            notes={filteredNotes()}
            filtered={
              selectedMonth() !== undefined || selectedTag() !== undefined
            }
            deletingNoteId={deletingNoteId()}
            deleteError={deleteError()}
            editingNoteId={editingNoteId()}
            onEdit={setEditingNoteId}
            onCancelEdit={() => setEditingNoteId(undefined)}
            onSave={reviseNote}
            onDelete={removeNote}
            onRetry={timeline.refetch}
          />
        </div>
      </div>
    </main>
  );
}

function FilterSection(props: { title: string; children: JSX.Element }) {
  return (
    <section class="filter-section">
      <h2>{props.title}</h2>
      <nav aria-label={props.title}>{props.children}</nav>
    </section>
  );
}

function FilterButton(props: {
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      class="filter-button"
      classList={{ "filter-button--selected": props.selected }}
      aria-pressed={props.selected}
      onClick={props.onSelect}
    >
      <span>{props.label}</span>
      <Badge tone={props.selected ? "accent" : "neutral"}>{props.count}</Badge>
    </button>
  );
}

function Timeline(props: {
  loading: boolean;
  error: unknown;
  notes: NoteTimeline;
  filtered: boolean;
  deletingNoteId: string | undefined;
  deleteError: string | undefined;
  editingNoteId: string | undefined;
  onEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSave: (id: string, draft: NoteDraft) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onRetry: () => void;
}) {
  return (
    <section class="timeline" aria-labelledby="timeline-heading">
      <div class="timeline__heading">
        <h2 id="timeline-heading">Timeline</h2>
        <span>{props.notes.length.toString().padStart(2, "0")}</span>
      </div>

      <Show when={props.deleteError}>
        <p class="timeline__delete-error" role="alert">
          {props.deleteError}
        </p>
      </Show>

      <Show when={props.loading}>
        <p class="timeline__state">Loading your notes…</p>
      </Show>

      <Show when={props.error}>
        <div class="timeline__state timeline__state--error" role="alert">
          <p>Couldn’t load your notes.</p>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            onClick={props.onRetry}
          >
            Try again
          </Button>
        </div>
      </Show>

      <Show when={!props.loading && props.error === undefined}>
        <Show
          when={props.notes.length > 0}
          fallback={
            <p class="timeline__state">
              {props.filtered
                ? "No notes match these filters."
                : "Your timeline is empty. Capture the first thought above."}
            </p>
          }
        >
          <For each={props.notes}>
            {(note) => (
              <article class="timeline-note">
                <div class="timeline-note__meta">
                  <time datetime={note.createdAt.toISOString()}>
                    {formatTimestamp(note.createdAt)}
                  </time>
                  <IconButton
                    type="button"
                    class="timeline-note__delete"
                    aria-label={`Delete${note.title ? ` ${note.title}` : " note"}`}
                    title="Delete note"
                    disabled={props.deletingNoteId === note.id}
                    onClick={() => void props.onDelete(note.id)}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      width="15"
                      height="15"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M19 6l-1 14H6L5 6" />
                      <path d="M10 11v5M14 11v5" />
                    </svg>
                  </IconButton>
                </div>
                <Show
                  when={props.editingNoteId === note.id}
                  fallback={
                    <div
                      class="timeline-note__content"
                      role="group"
                      tabindex="0"
                      aria-label="Note content. Double-click or press Enter to edit."
                      title="Double-click to edit"
                      onDblClick={() => props.onEdit(note.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          props.onEdit(note.id);
                        }
                      }}
                    >
                      {note.title && <h3>{note.title}</h3>}
                      <div
                        class="markdown-body"
                        innerHTML={micromark(note.content)}
                      />
                    </div>
                  }
                >
                  <InlineNoteEditor
                    title={note.title}
                    content={note.content}
                    onCancel={props.onCancelEdit}
                    onSave={(draft) => props.onSave(note.id, draft)}
                  />
                </Show>
              </article>
            )}
          </For>
        </Show>
      </Show>
    </section>
  );
}

function formatTimestamp(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function monthKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonth(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(new Date(year!, month! - 1, 1));
}
