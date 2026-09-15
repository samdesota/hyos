import { useLocation, useMatch, useNavigate } from "@solidjs/router";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Component,
  type JSX,
} from "solid-js";

import type { AgentSound } from "../agent-sound-renderer/types.js";
import type { AgentSessionSummary } from "../../capabilities/agent.js";
import type { AppState } from "./app-state.js";
import type { WindowControlsClient } from "./client.js";
import { globalTabDescriptors, globalTabLabel } from "./global-tabs.js";
import { Modal } from "./Modal.js";
import { ROUTE_PATHS } from "./session-route.js";
import { WindowControls } from "./WindowControls.js";
import {
  groupSessionsByFolder,
  orderedFolderGroups,
} from "./sessions-model.js";

/**
 * Folder glyph for the collapse toggle: closed when the group is shown
 * collapsed, open when expanded (lucide `folder` / `folder-open` paths).
 */
const FolderIcon: Component<{ open: boolean }> = (props) => (
  <svg
    class="session-folder-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <Show
      when={props.open}
      fallback={
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      }
    >
      <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
    </Show>
  </svg>
);

const SessionFolderList: Component<{
  sessions: readonly AgentSessionSummary[];
  /** Persisted manual folder order; folders absent from it keep group order. */
  savedFolderOrder?: readonly string[] | null;
  /** Folders currently collapsed (persisted host-side). */
  collapsedFolders: ReadonlySet<string>;
  /** Toggle one folder's collapsed state (persists via the host). */
  onToggleCollapse: (folder: string, collapsed: boolean) => void;
  /** Commit a manual folder order (persists via the host). */
  onReorderFolders: (order: readonly string[]) => void;
  children: (session: () => AgentSessionSummary) => JSX.Element;
}> = (props) => {
  // Key-stable rendering: folder sections are keyed by folder string and
  // session rows by session id (plain strings, so <For> diffs by value), and
  // all content reads the current summary through reactive lookups. The host
  // republishes the whole list on every streamed chunk (sessions are ordered
  // by updatedAt), so keying rows by object reference would tear the sidebar
  // down mid-interaction — losing hover on the archive button and the
  // mousedown/mouseup pairing clicks need. Field changes patch in place.
  const byId = createMemo(
    () =>
      new Map(props.sessions.map((session) => [session.id, session] as const)),
  );
  const groups = createMemo(() =>
    orderedFolderGroups(
      groupSessionsByFolder(props.sessions),
      props.savedFolderOrder ?? null,
    ),
  );
  // Folder drag-and-drop: the same pointer-lift model as session rows — a
  // ghost chip of the collapsed heading follows the pointer, the in-flow
  // heading leaves an invisible landing gap, displaced groups FLIP-animate
  // into their new slots, and the drop commits the order through the host's
  // reorder-folders command. The order override stays visible until the
  // host's published order catches up (or a safety timer fires), so the
  // list never snaps back mid-round-trip.
  const [dragFolder, setDragFolder] = createSignal<string | null>(null);
  const [dragOrder, setDragOrder] = createSignal<readonly string[] | null>(
    null,
  );
  // Transient, never-persisted collapse: the dragged group shrinks to just
  // its heading while dragged, so it travels as a compact chip.
  const [dragCollapsed, setDragCollapsed] = createSignal<ReadonlySet<string>>(
    new Set<string>(),
  );
  let ghostEl: HTMLDivElement | undefined;
  // Scoped hit-testing/FLIP root: with the active and archived lists sharing
  // heading markup, queries must never cross lists.
  let listEl: HTMLDivElement | undefined;

  const effectiveFolders = createMemo(() => {
    const computed = groups().map(({ folder }) => folder);
    const order = dragOrder();
    if (!order) return computed;
    const known = new Set(computed);
    const ordered = order.filter((folder) => known.has(folder));
    for (const folder of computed)
      if (!order.includes(folder)) ordered.push(folder);
    return ordered;
  });

  // Once the host publishes the committed order, the override is redundant.
  createEffect(() => {
    const order = dragOrder();
    if (!order || dragFolder()) return;
    const active = groups().map(({ folder }) => folder);
    if (
      active.length === order.length &&
      active.every((folder, index) => folder === order[index])
    )
      setDragOrder(null);
  });

  // FLIP siblings: after each reorder the DOM is already in its final layout,
  // so measure sections, diff against the previous frame's rects, and animate
  // the delta back to identity. Re-running animate() replaces the previous
  // animation, which keeps slides retargetable mid-flight. Slots are measured
  // from the untransformed <section>, never the FLIP-animated heading: a
  // heading's rect reflects the running animation transform, which fed
  // hit-testing a moving target and caused end-of-list oscillation.
  let folderRects = new Map<string, number>();
  createEffect(() => {
    if (!dragFolder() || !listEl) {
      folderRects = new Map();
      return;
    }
    effectiveFolders();
    const next = new Map<string, number>();
    for (const section of Array.from(
      listEl.querySelectorAll<HTMLElement>(
        ".session-folder-group[data-folder]",
      ),
    )) {
      const folder = section.dataset.folder;
      if (folder) next.set(folder, section.getBoundingClientRect().top);
    }
    for (const [folder, top] of next) {
      const previous = folderRects.get(folder);
      if (previous === undefined || previous === top) continue;
      listEl
        .querySelector<HTMLElement>(
          `.session-folder-heading[data-folder="${CSS.escape(folder)}"]`,
        )
        ?.animate(
          [
            { transform: `translateY(${previous - top}px)` },
            { transform: "translateY(0)" },
          ],
          { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
        );
    }
    folderRects = next;
  });

  const moveFolderTo = (dragged: string, index: number): void => {
    const current = effectiveFolders();
    const others = current.filter((folder) => folder !== dragged);
    if (index < 0 || index > others.length) return;
    const next = [...others.slice(0, index), dragged, ...others.slice(index)];
    const previous = dragOrder() ?? current;
    if (
      previous.length === next.length &&
      previous.every((folder, i) => folder === next[i])
    )
      return;
    setDragOrder(next);
  };

  /** Folder slot index whose gap the pointer is over (midpoint hit-testing). */
  const folderIndexAt = (dragged: string, y: number): number => {
    const others = effectiveFolders().filter((folder) => folder !== dragged);
    for (let index = 0; index < others.length; index++) {
      // Measure the untransformed section, not the animated heading, so a
      // running FLIP animation can't shift the midpoint under the pointer.
      const section = listEl?.querySelector<HTMLElement>(
        `.session-folder-group[data-folder="${CSS.escape(others[index])}"]`,
      );
      if (!section) continue;
      const rect = section.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return index;
    }
    return others.length;
  };

  const startFolderDrag = (folder: string, event: PointerEvent): void => {
    if (event.button !== 0) return;
    const heading = event.currentTarget as HTMLElement;
    const startY = event.clientY;
    let dragging = false;
    let grabDx = 0;
    let grabDy = 0;
    let pointerX = event.clientX;
    let pointerY = event.clientY;
    const placeGhost = (): void => {
      if (!ghostEl) return;
      ghostEl.style.width = `${heading.getBoundingClientRect().width}px`;
      ghostEl.style.transform = `translate(${pointerX - grabDx}px, ${pointerY - grabDy}px)`;
    };
    const engage = (): void => {
      dragging = true;
      const rect = heading.getBoundingClientRect();
      grabDx = pointerX - rect.left;
      grabDy = pointerY - rect.top;
      setDragFolder(folder);
      // Visually collapse just the dragged group (transient override — the
      // persisted collapse state is untouched) so it travels as a chip.
      setDragCollapsed((current) => new Set(current).add(folder));
      // The ghost node is created synchronously by the signal write; style it
      // on the next tick so it never flashes at its untransformed position.
      queueMicrotask(placeGhost);
    };
    const move = (moveEvent: PointerEvent): void => {
      pointerX = moveEvent.clientX;
      pointerY = moveEvent.clientY;
      if (!dragging) {
        if (Math.abs(pointerY - startY) < 5) return;
        engage();
      }
      moveEvent.preventDefault();
      placeGhost();
      moveFolderTo(folder, folderIndexAt(folder, pointerY));
    };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    const finish = (): void => {
      cleanup();
      // A press on the heading without crossing the drag threshold is a
      // click: toggle the folder's persisted collapse state.
      if (!dragging) {
        props.onToggleCollapse(folder, !isCollapsed(folder));
        return;
      }
      setDragFolder(null);
      setDragCollapsed((current) => {
        const next = new Set(current);
        next.delete(folder);
        return next;
      });
      const ordered = dragOrder();
      if (ordered) {
        props.onReorderFolders([...ordered]);
        // Keep the optimistic order visible until the host republishes (the
        // effect above clears it) or this safety timer fires on rejection.
        window.setTimeout(() => {
          if (dragOrder() === ordered) setDragOrder(null);
        }, 2000);
      }
    };
    const cancel = (): void => {
      cleanup();
      if (!dragging) return;
      setDragFolder(null);
      setDragCollapsed((current) => {
        const next = new Set(current);
        next.delete(folder);
        return next;
      });
      setDragOrder(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  };

  const ghostFolder = createMemo(() => {
    const folder = dragFolder();
    return folder
      ? (groups().find((group) => group.folder === folder) ?? null)
      : null;
  });

  // Collapse shown for a group: the persisted state plus the transient drag
  // override (never written back to the host).
  const isCollapsed = (folder: string): boolean =>
    props.collapsedFolders.has(folder) || dragCollapsed().has(folder);

  return (
    <div class="session-folder-list" ref={listEl}>
      <For each={effectiveFolders()}>
        {(folder) => (
          <Show when={groups().find((group) => group.folder === folder)}>
            {(group) => {
              const collapsed = () => isCollapsed(group().folder);
              return (
                <section
                  class="session-folder-group"
                  classList={{ collapsed: collapsed() }}
                  data-folder={group().folder}
                  aria-label={group().folder || group().label}
                >
                  <h3
                    class="session-folder-heading"
                    classList={{ dragging: dragFolder() === group().folder }}
                    data-folder={group().folder}
                    title={group().folder || group().label}
                    onPointerDown={(event) =>
                      startFolderDrag(group().folder, event)
                    }
                  >
                    <button
                      type="button"
                      class="session-folder-toggle"
                      aria-expanded={!collapsed()}
                      aria-label={
                        collapsed()
                          ? `Expand ${group().label}`
                          : `Collapse ${group().label}`
                      }
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onToggleCollapse(group().folder, !collapsed());
                      }}
                    >
                      <FolderIcon open={!collapsed()} />
                    </button>
                    <span class="session-folder-name">{group().label}</span>
                    <Show when={group().parentPath}>
                      <span class="session-folder-parent">
                        {group().parentPath}
                      </span>
                    </Show>
                  </h3>
                  <Show when={!collapsed()}>
                    <For each={group().sessions.map(({ id }) => id)}>
                      {(id) => props.children(() => byId().get(id)!)}
                    </For>
                  </Show>
                </section>
              );
            }}
          </Show>
        )}
      </For>
      <Show when={ghostFolder()}>
        {(group) => (
          <div class="session-folder-heading drag-ghost" ref={ghostEl}>
            <FolderIcon open={false} />
            <span class="session-folder-name">{group().label}</span>
            <Show when={group().parentPath}>
              <span class="session-folder-parent">{group().parentPath}</span>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
};

/**
 * Inline-renameable session title: double-click swaps the label for an
 * identically sized input with the full text pre-selected. Enter or blur
 * commits through the host's rename-session command; Escape discards.
 */
const SessionTitle: Component<{
  session: AgentSessionSummary;
  onRename: (title: string) => void;
}> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let input: HTMLInputElement | undefined;

  const startEditing = (): void => {
    setDraft(props.session.title);
    setEditing(true);
    // Focus once the input exists; select() highlights the full title.
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
  };
  const stopEditing = (): void => {
    setEditing(false);
  };
  const commit = (): void => {
    const title = draft().trim();
    stopEditing();
    if (title && title !== props.session.title) props.onRename(title);
  };

  return (
    <Show
      when={editing()}
      fallback={
        <span class="session-title" onDblClick={startEditing}>
          {props.session.title}
        </span>
      }
    >
      <input
        ref={input}
        class="session-title-input"
        type="text"
        aria-label="Session title"
        value={draft()}
        // Keep the wrapping button from re-selecting the session while
        // the user clicks or presses keys inside the input.
        onClick={(event) => {
          event.stopPropagation();
        }}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            stopEditing();
          }
        }}
      />
    </Show>
  );
};

/**
 * Session status line: nothing by default, a spinner plus the work
 * description while the session runs — "Working..." until the model-written
 * description arrives — and, once the run ends, a dot plus the outcome
 * summary (replacing the turn-start description), tinted blue on success.
 * It stays until the next turn starts.
 */
const SessionMeta: Component<{ session: AgentSessionSummary }> = (props) => (
  <span class="session-meta">
    <Show
      when={props.session.status === "running"}
      fallback={
        <Show when={props.session.statusDetail}>
          {(detail) => (
            <span
              class={`session-status-text ${props.session.status}`}
              // Seen: the outcome's description matches the one recorded
              // when the session was last opened — a fresh run writes a
              // new description, which re-arms the blue.
              classList={{
                seen:
                  props.session.seenStatusDetail === props.session.statusDetail,
              }}
            >
              {detail()}
            </span>
          )}
        </Show>
      }
    >
      <i class="session-spinner" aria-label="Running" />
      <span class="session-status-text running">
        {props.session.statusDetail ?? "Working..."}
      </span>
    </Show>
  </span>
);

/** App sidebar: brand, global tab strip, session list, finish-sound toggle. */
export const Sidebar: Component<{
  app: AppState;
  sound: AgentSound;
  windowControls: WindowControlsClient;
}> = (props) => {
  const { sound } = props;
  const navigate = useNavigate();
  const location = useLocation();
  // The highlighted session follows the URL, not internal state: only the
  // `/session/:id` route names an open session, so tab, archive, and
  // new-session routes highlight nothing.
  const sessionMatch = useMatch(() => ROUTE_PATHS.session);
  const routedSessionId = createMemo(() => {
    const id = sessionMatch()?.params.id;
    return id ? decodeURIComponent(id) : null;
  });
  // Mirror of the sound module's enabled state; the module owns the truth and
  // persists it, the signal only keeps the switch rendering in step.
  const [soundEnabled, setSoundEnabled] = createSignal(sound.isEnabled());
  const {
    activeSessions,
    browserState,
    globalTabs,
    focusGlobalTab,
    focusedGlobalTab,
    openGlobalTab,
    openWhiteboardTab,
    closeGlobalTab,
    selectSession,
    newSession,
    setSessionArchived,
    renameSession,
    reorderSessions,
    createOpen,
    setCreateOpen,
  } = props.app;
  const [createQuery, setCreateQuery] = createSignal("");
  const [createIndex, setCreateIndex] = createSignal(0);
  let createInput: HTMLInputElement | undefined;

  // Session drag-and-drop: Apple-style live reorder via pointer events (the
  // HTML5 drag API is both flaky in Chromium and incapable of this interaction).
  // Crossing the threshold "lifts" the row into a floating ghost that follows
  // the pointer raw (direct style writes, no easing); as the pointer crosses a
  // sibling's midpoint the optimistic dragOrder signal updates and the
  // displaced siblings FLIP-animate into their new slots. The invisible
  // in-flow dragged row marks the landing gap. Dropping commits the order
  // through the host's reorder-sessions command.
  const [dragSessionId, setDragSessionId] = createSignal<string | null>(null);
  // Optimistic active-list id order while dragging; null = render as-is.
  const [dragOrder, setDragOrder] = createSignal<readonly string[] | null>(
    null,
  );
  // Set once a drag actually engaged, so the trailing click on pointerup
  // doesn't select the session that was just dragged.
  let suppressNextClick = false;
  let ghostEl: HTMLDivElement | undefined;

  const effectiveSessions = createMemo(() => {
    const order = dragOrder();
    const sessions = activeSessions();
    if (!order) return sessions;
    const byId = new Map(sessions.map((s) => [s.id, s] as const));
    const ordered = order
      .map((id) => byId.get(id))
      .filter((s): s is AgentSessionSummary => Boolean(s));
    for (const session of sessions)
      if (!order.includes(session.id)) ordered.push(session);
    return ordered;
  });

  const ghostSession = createMemo(() => {
    const id = dragSessionId();
    return id ? (activeSessions().find((s) => s.id === id) ?? null) : null;
  });

  // FLIP siblings: after each reorder the DOM is already in its final layout,
  // so measure rows, diff against the previous frame's rects, and animate the
  // delta back to identity. Re-running animate() replaces the previous
  // animation, which keeps slides retargetable mid-flight.
  let rowRects = new Map<string, number>();
  createEffect(() => {
    if (!dragSessionId()) {
      rowRects = new Map();
      return;
    }
    effectiveSessions();
    const next = new Map<string, number>();
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>(".session-row[data-session-id]"),
    )) {
      const id = row.dataset.sessionId;
      if (id) next.set(id, row.getBoundingClientRect().top);
    }
    for (const [id, top] of next) {
      const previous = rowRects.get(id);
      if (previous === undefined || previous === top) continue;
      document
        .querySelector<HTMLElement>(
          `.session-row[data-session-id="${CSS.escape(id)}"]`,
        )
        ?.animate(
          [
            { transform: `translateY(${previous - top}px)` },
            { transform: "translateY(0)" },
          ],
          { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
        );
    }
    rowRects = next;
  });

  // Once the host publishes the committed order, the override is redundant.
  createEffect(() => {
    const order = dragOrder();
    if (!order || dragSessionId()) return;
    const active = activeSessions().map((s) => s.id);
    if (
      active.length === order.length &&
      active.every((id, index) => id === order[index])
    )
      setDragOrder(null);
  });

  const sessionById = (id: string): AgentSessionSummary | undefined =>
    activeSessions().find((session) => session.id === id);

  /** Move the dragged session so the pointer sits at `index` among its folder siblings. */
  const reorderDraggedTo = (draggedId: string, index: number): void => {
    const dragged = sessionById(draggedId);
    if (!dragged) return;
    const others = (dragOrder() ?? activeSessions().map((s) => s.id)).filter(
      (id) => {
        const session = sessionById(id);
        return session?.folder === dragged.folder && id !== draggedId;
      },
    );
    if (index < 0 || index > others.length) return;
    const folderIds = [
      ...others.slice(0, index),
      draggedId,
      ...others.slice(index),
    ];
    const queue = [...folderIds];
    const order = activeSessions().map((session) =>
      session.folder === dragged.folder ? queue.shift()! : session.id,
    );
    const current = dragOrder() ?? activeSessions().map((s) => s.id);
    if (
      current.length === order.length &&
      current.every((id, i) => id === order[i])
    )
      return;
    setDragOrder(order);
  };

  /** Folder slot index whose gap the pointer is over (midpoint hit-testing). */
  const dragIndexAt = (draggedId: string, y: number): number => {
    const dragged = sessionById(draggedId);
    if (!dragged) return -1;
    const others = effectiveSessions().filter(
      (session) =>
        session.folder === dragged.folder && session.id !== draggedId,
    );
    for (let index = 0; index < others.length; index++) {
      const row = document.querySelector<HTMLElement>(
        `.session-row[data-session-id="${CSS.escape(others[index].id)}"]`,
      );
      if (!row) continue;
      const rect = row.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return index;
    }
    return others.length;
  };

  const startSessionDrag = (id: string, event: PointerEvent): void => {
    const row = event.currentTarget as HTMLElement;
    const startY = event.clientY;
    let dragging = false;
    let grabDx = 0;
    let grabDy = 0;
    let pointerX = event.clientX;
    let pointerY = event.clientY;
    const placeGhost = (): void => {
      if (!ghostEl) return;
      ghostEl.style.width = `${row.getBoundingClientRect().width}px`;
      ghostEl.style.transform = `translate(${pointerX - grabDx}px, ${pointerY - grabDy}px)`;
    };
    const engage = (): void => {
      dragging = true;
      suppressNextClick = true;
      const rect = row.getBoundingClientRect();
      grabDx = pointerX - rect.left;
      grabDy = pointerY - rect.top;
      setDragSessionId(id);
      // The ghost node is created synchronously by the signal write; style it
      // on the next tick so it never flashes at its untransformed position.
      queueMicrotask(placeGhost);
    };
    const move = (moveEvent: PointerEvent): void => {
      pointerX = moveEvent.clientX;
      pointerY = moveEvent.clientY;
      if (!dragging) {
        if (Math.abs(pointerY - startY) < 5) return;
        engage();
      }
      moveEvent.preventDefault();
      placeGhost();
      reorderDraggedTo(id, dragIndexAt(id, pointerY));
    };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
    const finish = (): void => {
      cleanup();
      if (!dragging) return;
      const ordered = dragOrder();
      setDragSessionId(null);
      if (ordered) {
        void reorderSessions([...ordered]);
        // Keep the optimistic order visible until the host republishes (the
        // effect above clears it) or this safety timer fires on rejection.
        window.setTimeout(() => {
          if (dragOrder() === ordered) setDragOrder(null);
        }, 2000);
      }
    };
    const cancel = (): void => {
      cleanup();
      if (!dragging) return;
      setDragSessionId(null);
      setDragOrder(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  };

  // Reset the search/selection each time the modal opens, whether via the
  // "+" button or the app-level Cmd/Ctrl+T accelerator.
  createEffect(() => {
    if (createOpen()) {
      setCreateQuery("");
      setCreateIndex(0);
      // Focus on the next frame, after the portal content is in the DOM —
      // covers both the "+" button and the CmdOrCtrl+T accelerator.
      queueMicrotask(() => createInput?.focus());
    }
  });

  const createItems: readonly {
    id: string;
    label: string;
    hint: string;
    icon: string;
    run: () => void;
  }[] = [
    {
      id: "session",
      label: "Session",
      hint: "New agent session",
      icon: "✎",
      run: () => newSession(),
    },
    {
      id: "web",
      label: "Web",
      hint: "New browser tab",
      icon: "◉",
      run: () => void openGlobalTab(),
    },
    {
      id: "whiteboard",
      label: "Whiteboard",
      hint: "New whiteboard",
      icon: "▦",
      run: () => openWhiteboardTab(crypto.randomUUID()),
    },
  ];
  const filteredCreateItems = () => {
    const query = createQuery().trim().toLowerCase();
    if (!query) return createItems;
    return createItems.filter((item) =>
      item.label.toLowerCase().includes(query),
    );
  };
  const openCreateModal = (): void => {
    setCreateOpen(true);
  };
  const runCreateItem = (item: (typeof createItems)[number]): void => {
    setCreateOpen(false);
    item.run();
  };

  return (
    <aside class="agent-sidebar">
      <div class="sidebar-head">
        <WindowControls controls={props.windowControls} />
        <div class="brand">
          <strong>hyos</strong>
          <div class="brand-new-wrap">
            <button
              class="brand-new"
              type="button"
              aria-label="Create new"
              title="Create new"
              aria-haspopup="dialog"
              aria-expanded={createOpen()}
              onClick={openCreateModal}
            >
              <svg
                class="brand-new-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                {/* lucide plus */}
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <Modal
        open={createOpen()}
        onClose={() => setCreateOpen(false)}
        label="Create new"
        overBrowser
      >
        <div
          onKeyDown={(e) => {
            const items = filteredCreateItems();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCreateIndex((i) =>
                items.length ? (i + 1) % items.length : 0,
              );
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCreateIndex((i) =>
                items.length ? (i - 1 + items.length) % items.length : 0,
              );
            } else if (e.key === "Enter") {
              e.preventDefault();
              const item = items[createIndex()];
              if (item) runCreateItem(item);
            }
          }}
        >
          <input
            class="create-input"
            type="text"
            placeholder="Create new…"
            aria-label="Search what to create"
            ref={createInput}
            value={createQuery()}
            onInput={(e) => {
              setCreateQuery(e.currentTarget.value);
              setCreateIndex(0);
            }}
          />
          <div class="create-list" role="listbox">
            <For each={filteredCreateItems()}>
              {(item, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index() === createIndex()}
                  class="create-item"
                  classList={{ selected: index() === createIndex() }}
                  onClick={() => runCreateItem(item)}
                  onMouseEnter={() => setCreateIndex(index())}
                >
                  <span class="create-item-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span class="create-item-text">
                    <strong>{item.label}</strong>
                    <span class="create-item-hint">{item.hint}</span>
                  </span>
                </button>
              )}
            </For>
            <Show when={filteredCreateItems().length === 0}>
              <div class="create-empty">No matches</div>
            </Show>
          </div>
        </div>
      </Modal>
      <Show when={globalTabs().length > 0}>
        <div class="global-tabs" aria-label="Global tabs">
          <div class="global-tab-list" role="tablist">
            <For each={globalTabs()}>
              {(tab) => (
                <div
                  class="global-tab-row"
                  classList={{
                    active: focusedGlobalTab()?.id === tab.id,
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    class="global-tab"
                    aria-selected={focusedGlobalTab()?.id === tab.id}
                    title={globalTabLabel(tab, browserState())}
                    onClick={() => focusGlobalTab(tab.id)}
                  >
                    <span class="side-tab-icon" aria-hidden="true">
                      {globalTabDescriptors[tab.kind].icon}
                    </span>
                    <span class="side-tab-label">
                      {globalTabLabel(tab, browserState())}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="global-tab-close"
                    aria-label={`Close ${globalTabLabel(tab, browserState())}`}
                    title="Close tab"
                    onClick={() => closeGlobalTab(tab)}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
      <div class="session-list" id="agent-session-list">
        <SessionFolderList
          sessions={effectiveSessions()}
          savedFolderOrder={props.app.folderOrder()}
          collapsedFolders={props.app.collapsedFolders()}
          onToggleCollapse={props.app.setFolderCollapsed}
          onReorderFolders={(order) => props.app.persistFolderOrder(order)}
        >
          {(session) => (
            <Show when={session()}>
              {(s) => (
                <div
                  class="session-row"
                  classList={{
                    active: routedSessionId() === s().id,
                    // The lifted row leaves an invisible gap marking where
                    // the item will land.
                    dragging: dragSessionId() === s().id,
                  }}
                  data-session-id={s().id}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    startSessionDrag(s().id, event);
                  }}
                >
                  <button
                    type="button"
                    class="session-open"
                    onClick={() => {
                      if (suppressNextClick) {
                        suppressNextClick = false;
                        return;
                      }
                      void selectSession(s().id);
                    }}
                  >
                    <SessionTitle
                      session={s()}
                      onRename={(title) => void renameSession(s().id, title)}
                    />
                    <SessionMeta session={s()} />
                  </button>
                  <button
                    type="button"
                    class="session-archive"
                    aria-label={`Archive "${s().title}"`}
                    title="Archive session"
                    onClick={() => void setSessionArchived(s().id, true)}
                  >
                    ×
                  </button>
                </div>
              )}
            </Show>
          )}
        </SessionFolderList>
      </div>
      <div class="sidebar-footer">
        <button
          type="button"
          class="sound-toggle"
          aria-pressed={soundEnabled()}
          aria-label="Toggle agent chime"
          onClick={(event) => {
            event.stopPropagation();
            const next = !soundEnabled();
            setSoundEnabled(next);
            sound.setEnabled(next);
          }}
        >
          <span class="sound-toggle-tip" aria-hidden="true">
            Toggle agent chime
          </span>
          <svg
            class="sound-toggle-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <Show
              when={soundEnabled()}
              fallback={
                <>
                  {/* lucide volume-x */}
                  <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 20.298z" />
                  <line x1="22" y1="9" x2="16" y2="15" />
                  <line x1="16" y1="9" x2="22" y2="15" />
                </>
              }
            >
              <>
                {/* lucide volume-2 */}
                <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 20.298z" />
                <path d="M16 9a5 5 0 0 1 0 6" />
                <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
              </>
            </Show>
          </svg>
        </button>
        <button
          type="button"
          class="archive-open"
          classList={{ active: location.pathname === ROUTE_PATHS.archive }}
          aria-label="Archived sessions"
          onClick={() => navigate(ROUTE_PATHS.archive)}
        >
          <span class="sound-toggle-tip" aria-hidden="true">
            Archived sessions
          </span>
          <svg
            class="sound-toggle-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            {/* lucide archive */}
            <rect width="18" height="4" x="3" y="4" rx="1" />
            <path d="M5 8v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
            <path d="M10 12h4" />
          </svg>
        </button>
      </div>
      <Show when={ghostSession()}>
        {(s) => (
          <div class="session-row drag-ghost" ref={ghostEl}>
            <button type="button" class="session-open" tabindex="-1">
              <span class="session-title">{s().title}</span>
              <Show when={s().statusDetail}>
                {(detail) => (
                  <span class="session-meta">
                    <span class={`session-status-text ${s().status}`}>
                      {detail()}
                    </span>
                  </span>
                )}
              </Show>
            </button>
          </div>
        )}
      </Show>
    </aside>
  );
};
