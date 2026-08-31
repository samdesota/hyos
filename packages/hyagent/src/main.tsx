import {
  createTRPCClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
} from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { render } from "solid-js/web";

import { decodeActivityEvent, type AgentActivityEvent } from "./activity.js";
import type { LiterateBlock } from "./domain.js";
import type { HyagentRouter } from "./trpc.js";
import "./styles.css";
import { shouldShowWorkspacePicker } from "./workspace-state.js";

// PROTOTYPE: Three variants of the two-column agent/literate-diff workspace,
// switchable via ?variant=. The winning interaction should be rebuilt cleanly.
const variants = [
  { key: "A", name: "Dark review" },
  { key: "B", name: "Compact manuscript" },
  { key: "C", name: "Technical document" },
] as const;
type VariantKey = (typeof variants)[number]["key"];
type UiSession = inferRouterOutputs<HyagentRouter>["session"]["bootstrap"];
type SessionListItem =
  inferRouterOutputs<HyagentRouter>["session"]["list"][number];
type WorkspaceRepository =
  inferRouterOutputs<HyagentRouter>["workspace"]["current"][number];
type ReviewComment = { id: string; target: string; body: string };

const wsClient = createWSClient({
  url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/trpc`,
  lazy: { enabled: true, closeMs: 1_000 },
});
const client = createTRPCClient<HyagentRouter>({
  links: [
    splitLink({
      condition: (operation) => operation.type === "subscription",
      true: wsLink({ client: wsClient }),
      false: httpBatchLink({ url: "/trpc" }),
    }),
  ],
});

function currentVariant(): VariantKey {
  const value = new URLSearchParams(location.search).get("variant");
  return variants.some((variant) => variant.key === value)
    ? (value as VariantKey)
    : "A";
}

function formatTime(value: Date | string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

type ThreadMessage = UiSession["messages"][number];
type ActivityRun = {
  kind: "activity";
  runId: string;
  events: Array<{
    activity: AgentActivityEvent;
    createdAt: Date | string;
  }>;
};
type ThreadItem = { kind: "message"; message: ThreadMessage } | ActivityRun;

function threadTimeline(messages: readonly ThreadMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  const runs = new Map<string, ActivityRun>();
  for (const message of messages) {
    const activity = decodeActivityEvent(message.content);
    if (!activity) {
      items.push({ kind: "message", message });
      continue;
    }
    let run = runs.get(activity.runId);
    if (!run) {
      run = { kind: "activity", runId: activity.runId, events: [] };
      runs.set(activity.runId, run);
      items.push(run);
    }
    run.events.push({ activity, createdAt: message.createdAt });
  }
  return items;
}

function ActivityStream(props: { run: ActivityRun }) {
  const latest = () => props.run.events.at(-1)!.activity;
  const updates = () =>
    props.run.events.filter(({ activity }) => activity.status === "working");
  const working = () => latest().status === "working";
  return (
    <details class="activity-stream" open={working()}>
      <summary>
        <i class={working() ? "working" : latest().status} />
        <strong>{latest().summary}</strong>
        <span>{updates().length} updates</span>
        <b>›</b>
      </summary>
      <ol>
        <For each={updates()}>
          {({ activity, createdAt }) => (
            <li>
              <span>{activity.summary}</span>
              <time>{formatTime(createdAt)}</time>
            </li>
          )}
        </For>
      </ol>
    </details>
  );
}

function badge(status: UiSession["status"]): string {
  return status === "committed"
    ? "Committed"
    : status === "running"
      ? "Agent working"
      : status === "failed"
        ? "Needs attention"
        : "Open for review";
}

interface WorkspaceProps {
  session: UiSession;
  feedback: string;
  busy: boolean;
  agentConfigured: boolean;
  error: string;
  comments: ReviewComment[];
  following: boolean;
  setFeedback(value: string): void;
  addComment(target: string, body: string): void;
  submitComments(): void;
  toggleFollowing(): void;
  send(): void;
  commit(): void;
}

function patchFile(block: Extract<LiterateBlock, { kind: "apply_patch" }>) {
  const path =
    block.file ??
    block.patch.match(/^diff --git a\/(.+?) b\//m)?.[1] ??
    "Changed file";
  return `${block.repository}/${path}`;
}

function patchStats(patch: string) {
  const lines = patch.split("\n");
  return {
    added: lines.filter(
      (line) => line.startsWith("+") && !line.startsWith("+++"),
    ).length,
    removed: lines.filter(
      (line) => line.startsWith("-") && !line.startsWith("---"),
    ).length,
  };
}

type CodeRow = {
  kind: "context" | "added" | "removed" | "gap";
  code: string;
  oldLine?: number;
  newLine?: number;
};

function diffRows(patch: string): CodeRow[] {
  const rows: CodeRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      const nextOldLine = Number(hunk[1]);
      const nextNewLine = Number(hunk[2]);
      if (inHunk && nextOldLine > oldLine) {
        rows.push({
          kind: "gap",
          code: `${nextOldLine - oldLine} unchanged lines`,
        });
      }
      oldLine = nextOldLine;
      newLine = nextNewLine;
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      rows.push({ kind: "added", code: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "removed", code: line.slice(1), oldLine });
      oldLine += 1;
    } else {
      rows.push({
        kind: "context",
        code: line.startsWith(" ") ? line.slice(1) : line,
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

function syntaxTokens(code: string) {
  const pattern =
    /("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\/\/.*|\b(?:async|await|boolean|const|export|extends|false|from|function|import|interface|let|number|readonly|return|string|true|type)\b|\b\d+\b)/g;
  const tokens: Array<{ text: string; kind?: string }> = [];
  let cursor = 0;
  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ text: code.slice(cursor, index) });
    const text = match[0];
    const kind = text.startsWith("//")
      ? "comment"
      : /^["'`]/.test(text)
        ? "string"
        : /^\d/.test(text)
          ? "number"
          : "keyword";
    tokens.push({ text, kind });
    cursor = index + text.length;
  }
  if (cursor < code.length) tokens.push({ text: code.slice(cursor) });
  return tokens;
}

function CodeView(props: { patch?: string; fullFile?: string }) {
  const rows = () =>
    props.fullFile !== undefined
      ? props.fullFile.split("\n").map((code, index): CodeRow => ({
          kind: "context",
          code,
          oldLine: index + 1,
          newLine: index + 1,
        }))
      : diffRows(props.patch ?? "");
  return (
    <div class={`code-view ${props.fullFile !== undefined ? "full-file" : ""}`}>
      <For each={rows()}>
        {(row) => (
          <div class={`code-line ${row.kind}`}>
            <Show
              when={row.kind !== "gap"}
              fallback={
                <>
                  <span class="line-number">⋯</span>
                  <button class="unchanged-gap">{row.code}</button>
                </>
              }
            >
              <span class="line-number">
                {row.kind === "removed" ? row.oldLine : row.newLine}
              </span>
              <span class="diff-sign">
                {row.kind === "added"
                  ? "+"
                  : row.kind === "removed"
                    ? "−"
                    : " "}
              </span>
              <code>
                <For each={syntaxTokens(row.code)}>
                  {(token) => (
                    <span
                      class={token.kind ? `syntax-${token.kind}` : undefined}
                    >
                      {token.text}
                    </span>
                  )}
                </For>
              </code>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

function Block(props: {
  block: LiterateBlock;
  editing: boolean;
  onComment(target: string, body: string): void;
}) {
  const [showFullFile, setShowFullFile] = createSignal(false);
  const [commenting, setCommenting] = createSignal(false);
  const [comment, setComment] = createSignal("");
  const submitComment = () => {
    if (!comment().trim()) return;
    props.onComment(
      props.block.kind === "apply_patch"
        ? patchFile(props.block)
        : "Document text",
      comment(),
    );
    setComment("");
    setCommenting(false);
  };
  return (
    <article class={`diff-block block-${props.block.kind}`}>
      <h3 class="document-section-title">{props.block.title}</h3>
      <Switch>
        <Match when={props.block.kind === "prose"}>
          <div class="commentable-content">
            <p>
              {(props.block as Extract<LiterateBlock, { kind: "prose" }>).body}
              <Show when={props.editing}>
                <span class="agent-caret" />
              </Show>
            </p>
            <button class="add-comment" onClick={() => setCommenting(true)}>
              +
            </button>
          </div>
        </Match>
        <Match when={props.block.kind === "diagram"}>
          <div class="commentable-content">
            <pre class="diagram">
              {
                (props.block as Extract<LiterateBlock, { kind: "diagram" }>)
                  .body
              }
            </pre>
            <button class="add-comment" onClick={() => setCommenting(true)}>
              +
            </button>
          </div>
        </Match>
        <Match when={props.block.kind === "apply_patch"}>
          {(() => {
            const block = props.block as Extract<
              LiterateBlock,
              { kind: "apply_patch" }
            >;
            const stats = patchStats(block.patch);
            return (
              <>
                <p class="rationale">{block.rationale}</p>
                <details class="file-diff" open>
                  <summary>
                    <span class="file-chevron">›</span>
                    <strong>{patchFile(block)}</strong>
                    <span class="diff-stats">
                      <b>+{stats.added}</b>
                      <i>−{stats.removed}</i>
                    </span>
                    <label onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={showFullFile()}
                        onChange={(event) =>
                          setShowFullFile(event.currentTarget.checked)
                        }
                      />
                      Show full file
                    </label>
                    <button
                      class="file-comment"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setCommenting(true);
                      }}
                    >
                      Comment
                    </button>
                  </summary>
                  <CodeView
                    patch={showFullFile() ? undefined : block.patch}
                    fullFile={showFullFile() ? block.fullFile : undefined}
                  />
                </details>
              </>
            );
          })()}
        </Match>
      </Switch>
      <Show when={commenting()}>
        <div class="inline-comment">
          <textarea
            autofocus
            value={comment()}
            onInput={(event) => setComment(event.currentTarget.value)}
            placeholder="Leave a comment…"
          />
          <div>
            <button onClick={() => setCommenting(false)}>Cancel</button>
            <button disabled={!comment().trim()} onClick={submitComment}>
              Add to review
            </button>
          </div>
        </div>
      </Show>
    </article>
  );
}

function ReviewBatch(props: WorkspaceProps) {
  return (
    <Show when={props.comments.length > 0}>
      <section class="review-batch">
        <header>
          <strong>Review comments</strong>
          <span>{props.comments.length}</span>
        </header>
        <For each={props.comments}>
          {(comment) => (
            <div>
              <b>{comment.target}</b>
              <p>{comment.body}</p>
            </div>
          )}
        </For>
        <button disabled={props.busy} onClick={props.submitComments}>
          Submit review batch
        </button>
      </section>
    </Show>
  );
}

function FollowButton(props: WorkspaceProps) {
  return (
    <button
      class={`follow ${props.following ? "active" : ""}`}
      onClick={props.toggleFollowing}
    >
      <span />
      {props.following ? "Following agent" : "Follow agent"}
    </button>
  );
}

function Composer(props: WorkspaceProps) {
  return (
    <div class="composer">
      <textarea
        value={props.feedback}
        disabled={!props.agentConfigured}
        onInput={(event) => props.setFeedback(event.currentTarget.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
            props.send();
        }}
        placeholder="Challenge a decision, request evidence, or redirect the change…"
      />
      <div>
        <span>⌘ ↵ to send</span>
        <button
          disabled={
            !props.agentConfigured || props.busy || !props.feedback.trim()
          }
          onClick={props.send}
        >
          Give feedback <b>→</b>
        </button>
      </div>
    </div>
  );
}

function WorkspacePicker(props: {
  repositories: WorkspaceRepository[];
  busy: boolean;
  error: string;
  chooseFolder(): void;
  addPath(path: string): void;
  updateName(index: number, name: string): void;
  remove(index: number): void;
  start(): void;
}) {
  const [path, setPath] = createSignal("");
  const addPath = () => {
    if (!path().trim()) return;
    props.addPath(path().trim());
    setPath("");
  };
  return (
    <main class="workspace-start">
      <header class="start-brand">
        <div class="mark">hy</div>
        <strong>hyagent</strong>
      </header>
      <section class="workspace-open">
        <header>
          <h1>Open workspace</h1>
          <p>Select one or more Git repositories.</p>
        </header>
        <div class="workspace-actions">
          <button
            class="choose-folder"
            disabled={props.busy}
            onClick={props.chooseFolder}
          >
            Choose folder
          </button>
          <span>or</span>
          <input
            value={path()}
            onInput={(event) => setPath(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && addPath()}
            placeholder="/absolute/path/to/repository"
          />
          <button disabled={!path().trim()} onClick={addPath}>
            Add
          </button>
        </div>
        <Show when={props.repositories.length > 0}>
          <div class="selected-folders">
            <For each={props.repositories}>
              {(repository, index) => (
                <div class="selected-folder">
                  <div>
                    <input
                      aria-label="Repository name"
                      value={repository.name}
                      onInput={(event) =>
                        props.updateName(index(), event.currentTarget.value)
                      }
                    />
                    <code>{repository.root}</code>
                  </div>
                  <button
                    aria-label="Remove repository"
                    onClick={() => props.remove(index())}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.error}>
          <p class="start-error">{props.error}</p>
        </Show>
        <div class="start-footer">
          <p>Existing worktree changes are preserved as the baseline.</p>
          <button
            class="start-task"
            disabled={props.busy || props.repositories.length === 0}
            onClick={props.start}
          >
            {props.busy ? "Opening…" : "Open workspace"}
          </button>
        </div>
      </section>
    </main>
  );
}

function VariantA(props: WorkspaceProps) {
  const timeline = () => threadTimeline(props.session.messages);
  const hasWorkingActivity = () =>
    timeline().some(
      (item) =>
        item.kind === "activity" &&
        item.events.at(-1)?.activity.status === "working",
    );
  return (
    <main class="workspace variant-a">
      <section class="thread-column">
        <header class="app-header">
          <div class="mark">hy</div>
          <div>
            <strong>hyagent</strong>
            <span>literate changes</span>
          </div>
        </header>
        <div class="thread-heading">
          <span class="eyebrow">Active thread</span>
          <h1>{props.session.title}</h1>
          <div class="status">
            <i />
            {badge(props.session.status)}
          </div>
        </div>
        <div class="messages">
          <For each={timeline()}>
            {(item) => (
              <Show
                when={item.kind === "message" ? item.message : undefined}
                fallback={<ActivityStream run={item as ActivityRun} />}
              >
                {(message) => (
                  <article class={`message ${message().role}`}>
                    <header>
                      <span>
                        {message().role === "agent"
                          ? "hyagent"
                          : message().role === "user"
                            ? "You"
                            : "System"}
                      </span>
                      <time>{formatTime(message().createdAt)}</time>
                    </header>
                    <p>{message().content}</p>
                  </article>
                )}
              </Show>
            )}
          </For>
          <Show when={props.busy && !hasWorkingActivity()}>
            <article class="message agent thinking">
              <header>
                <span>hyagent</span>
              </header>
              <p>
                Inspecting the project and rewriting the story<span>•••</span>
              </p>
            </article>
          </Show>
        </div>
        <Show when={props.error}>
          <p class="error">{props.error}</p>
        </Show>
        <Show when={!props.agentConfigured}>
          <p class="error">
            Agent unavailable. Start the server with AI_GATEWAY_API_KEY.
          </p>
        </Show>
        <ReviewBatch {...props} />
        <Composer {...props} />
      </section>
      <section class="diff-column paper">
        <header class="diff-heading">
          <div>
            <span class="eyebrow">
              Revision {props.session.revision?.number ?? 0}
            </span>
            <h2>
              {props.session.revision?.summary ?? "Waiting for the first draft"}
            </h2>
          </div>
          <div class="document-actions">
            <FollowButton {...props} />
            <button
              class="commit"
              disabled={
                props.busy ||
                props.session.status === "committed" ||
                !props.session.revision
              }
              onClick={props.commit}
            >
              {props.session.status === "committed"
                ? "Committed ✓"
                : "Accept changes"}
            </button>
          </div>
        </header>
        <div class="document-flow">
          <Show when={!props.session.revision}>
            <section class="empty-document">
              <span>Empty document</span>
              <h3>The agent’s first overview will appear here.</h3>
              <p>
                Describe the change in the thread. The literate diff will grow
                as the agent investigates and edits the selected repositories.
              </p>
            </section>
          </Show>
          <For each={props.session.revision?.blocks ?? []}>
            {(block) => (
              <Block
                block={block}
                editing={props.busy}
                onComment={props.addComment}
              />
            )}
          </For>
          <Show
            when={(props.session.revision?.generatedIgnores.length ?? 0) > 0}
          >
            <section class="generated-ignores">
              <h3>Generated artifacts not included</h3>
              <For each={props.session.revision?.generatedIgnores ?? []}>
                {(entry) => (
                  <div>
                    <code>
                      {entry.repository}/{entry.path}
                    </code>
                    <p>{entry.reason}</p>
                  </div>
                )}
              </For>
            </section>
          </Show>
        </div>
      </section>
    </main>
  );
}

function VariantB(props: WorkspaceProps) {
  return (
    <main class="workspace variant-b">
      <aside class="manuscript-thread">
        <header>
          <div class="wordmark">
            HYAGENT / <i>01</i>
          </div>
          <span class="status-label">{badge(props.session.status)}</span>
        </header>
        <h1>{props.session.title}</h1>
        <p class="thread-intro">
          A conversation in the margin of the proposed change.
        </p>
        <ol class="margin-conversation">
          <For each={props.session.messages}>
            {(message, index) => (
              <li class={message.role}>
                <span>{String(index() + 1).padStart(2, "0")}</span>
                <div>
                  <b>{message.role}</b>
                  <p>{message.content}</p>
                </div>
              </li>
            )}
          </For>
        </ol>
        <Show when={props.error}>
          <p class="error">{props.error}</p>
        </Show>
        <ReviewBatch {...props} />
        <Composer {...props} />
      </aside>
      <article class="manuscript">
        <header class="folio">
          <span>Revision {props.session.revision?.number ?? 0}</span>
          <FollowButton {...props} />
          <button
            disabled={
              props.busy ||
              props.session.status === "committed" ||
              !props.session.revision
            }
            onClick={props.commit}
          >
            {props.session.status === "committed"
              ? "Committed"
              : "Accept & commit"}
          </button>
        </header>
        <div class="manuscript-title">
          <h2>{props.session.revision?.summary}</h2>
        </div>
        <div class="manuscript-body">
          <For each={props.session.revision?.blocks ?? []}>
            {(block) => (
              <Block
                block={block}
                editing={props.busy}
                onComment={props.addComment}
              />
            )}
          </For>
        </div>
      </article>
    </main>
  );
}

function VariantC(props: WorkspaceProps) {
  const patches = createMemo(
    () =>
      props.session.revision?.blocks.filter(
        (block) => block.kind === "apply_patch",
      ).length ?? 0,
  );
  return (
    <main class="workspace variant-c">
      <section class="control-room">
        <header>
          <div class="mark light">h</div>
          <strong>Change room</strong>
          <span>POC / 001</span>
        </header>
        <div class="control-title">
          <span>THREAD</span>
          <h1>{props.session.title}</h1>
          <div class="metrics">
            <div>
              <b>{props.session.revision?.number ?? 0}</b>
              <small>revision</small>
            </div>
            <div>
              <b>{patches()}</b>
              <small>patches</small>
            </div>
            <div>
              <b>
                {
                  props.session.messages.filter(
                    (message) => message.role === "user",
                  ).length
                }
              </b>
              <small>reviews</small>
            </div>
          </div>
        </div>
        <div class="control-messages">
          <For each={props.session.messages}>
            {(message) => (
              <article class={message.role}>
                <header>
                  <b>
                    {message.role === "user"
                      ? "REVIEWER"
                      : message.role.toUpperCase()}
                  </b>
                  <time>{formatTime(message.createdAt)}</time>
                </header>
                <p>{message.content}</p>
              </article>
            )}
          </For>
        </div>
        <Show when={props.error}>
          <p class="error">{props.error}</p>
        </Show>
        <ReviewBatch {...props} />
        <Composer {...props} />
      </section>
      <section class="ledger">
        <header>
          <div>
            <span>Revision {props.session.revision?.number ?? 0}</span>
            <h2>{props.session.revision?.summary}</h2>
          </div>
          <div class="ledger-actions">
            <FollowButton {...props} />
            <button
              disabled={
                props.busy ||
                props.session.status === "committed" ||
                !props.session.revision
              }
              onClick={props.commit}
            >
              {props.session.status === "committed"
                ? "COMMITTED ✓"
                : "COMMIT REVISION"}
            </button>
          </div>
        </header>
        <div class="ledger-line" />
        <div class="ledger-blocks">
          <For each={props.session.revision?.blocks ?? []}>
            {(block) => (
              <Block
                block={block}
                editing={props.busy}
                onComment={props.addComment}
              />
            )}
          </For>
        </div>
      </section>
    </main>
  );
}

function PrototypeSwitcher(props: { current: VariantKey }) {
  if (!import.meta.env.DEV) return null;
  const move = (direction: number) => {
    const index = variants.findIndex(
      (variant) => variant.key === props.current,
    );
    const next =
      variants[(index + direction + variants.length) % variants.length];
    const url = new URL(location.href);
    url.searchParams.set("variant", next.key);
    location.href = url.toString();
  };
  onMount(() =>
    addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement;
      if (
        ["INPUT", "TEXTAREA"].includes(target.tagName) ||
        target.isContentEditable
      )
        return;
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    }),
  );
  const current = variants.find((variant) => variant.key === props.current)!;
  return (
    <nav class="prototype-switcher">
      <button onClick={() => move(-1)}>←</button>
      <span>
        {current.key} · {current.name}
      </span>
      <button onClick={() => move(1)}>→</button>
    </nav>
  );
}

function SessionSidebar(props: {
  sessions: SessionListItem[];
  activeId: string;
  disabled: boolean;
  select(id: string): void;
  create(): void;
  archive(id: string): void;
}) {
  return (
    <aside class="session-sidebar">
      <header>
        <div class="sidebar-mark">hy</div>
        <strong>hyagent</strong>
        <button
          aria-label="New session"
          title="New session"
          disabled={props.disabled}
          onClick={props.create}
        >
          +
        </button>
      </header>
      <nav aria-label="Agent sessions">
        <For each={props.sessions}>
          {(item) => (
            <div
              class="session-row"
              classList={{ active: item.id === props.activeId }}
            >
              <button
                class="session-select"
                disabled={props.disabled}
                onClick={() => props.select(item.id)}
              >
                <span class={`session-dot ${item.status}`} />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.status === "committed"
                      ? "Committed"
                      : badge(item.status)}
                    {" · "}
                    {formatTime(item.updatedAt)}
                  </small>
                </span>
              </button>
              <button
                class="session-archive"
                aria-label={`Archive ${item.title}`}
                title="Archive session"
                disabled={props.disabled || item.status === "running"}
                onClick={() => props.archive(item.id)}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </nav>
    </aside>
  );
}

function App() {
  const [session, setSession] = createSignal<UiSession>();
  const [sessions, setSessions] = createSignal<SessionListItem[]>([]);
  const [repositories, setRepositories] = createSignal<WorkspaceRepository[]>(
    [],
  );
  const [feedback, setFeedback] = createSignal("");
  const [operationBusy, setOperationBusy] = createSignal(false);
  const [agentStarting, setAgentStarting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [comments, setComments] = createSignal<ReviewComment[]>([]);
  const [following, setFollowing] = createSignal(true);
  const [agentConfigured, setAgentConfigured] = createSignal(true);
  const [workspaceOpen, setWorkspaceOpen] = createSignal(false);
  const busy = createMemo(
    () => operationBusy() || agentStarting() || session()?.status === "running",
  );
  createEffect(() => {
    if (!busy() || !following()) return;
    queueMicrotask(() =>
      document
        .querySelector(".agent-caret")
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  });
  function setSessionUrl(id: string, mode: "push" | "replace") {
    const url = new URL(location.href);
    url.searchParams.set("session", id);
    history[mode === "push" ? "pushState" : "replaceState"]({}, "", url);
  }
  async function openSession(id: string, historyMode?: "push" | "replace") {
    setOperationBusy(true);
    setError("");
    try {
      const opened = await client.session.open.query({ id });
      setAgentStarting(false);
      setSession(opened.session);
      setRepositories([...opened.repositories]);
      setWorkspaceOpen(opened.repositories.length > 0);
      setComments([]);
      if (historyMode) setSessionUrl(id, historyMode);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not open session",
      );
    } finally {
      setOperationBusy(false);
    }
  }
  onMount(() => {
    const listSubscription = client.session.watchList.subscribe(undefined, {
      onData(items) {
        setSessions([...items]);
      },
      onError(cause) {
        setError(cause.message || "Could not update sessions");
      },
    });
    const handleHistory = () => {
      const id = new URL(location.href).searchParams.get("session");
      if (id && id !== session()?.id) void openSession(id);
    };
    addEventListener("popstate", handleHistory);
    onCleanup(() => {
      listSubscription.unsubscribe();
      removeEventListener("popstate", handleHistory);
    });

    void (async () => {
      try {
        const health = await client.health.query();
        const requested = new URL(location.href).searchParams.get("session");
        let loaded: Awaited<ReturnType<typeof client.session.open.query>>;
        if (requested) {
          try {
            loaded = await client.session.open.query({ id: requested });
          } catch {
            const fallback = await client.session.bootstrap.query();
            loaded = await client.session.open.query({ id: fallback.id });
          }
        } else {
          const fallback = await client.session.bootstrap.query();
          loaded = await client.session.open.query({ id: fallback.id });
        }
        setSession(loaded.session);
        setRepositories([...loaded.repositories]);
        setAgentConfigured(health.agentConfigured);
        setWorkspaceOpen(loaded.repositories.length > 0);
        setSessionUrl(loaded.session.id, "replace");
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Could not load session",
        );
      }
    })();
  });
  const sessionId = createMemo(() => session()?.id);
  createEffect(() => {
    const id = sessionId();
    if (!id) return;
    const subscription = client.session.watch.subscribe(
      { id },
      {
        onData(next) {
          setSession(next);
          if (next.status === "running" || next.status === "failed") {
            setAgentStarting(false);
          }
        },
        onError(cause) {
          setAgentStarting(false);
          setError(cause.message || "Live session connection failed");
        },
      },
    );
    onCleanup(() => subscription.unsubscribe());
  });
  const sendFeedback = async (text: string, onSuccess?: () => void) => {
    const current = session();
    if (!current || !text.trim() || busy()) return;
    if (!agentConfigured()) {
      setError("Agent unavailable. Start the server with AI_GATEWAY_API_KEY.");
      return;
    }
    setAgentStarting(true);
    setError("");
    try {
      await client.session.feedback.mutate({
        id: current.id,
        feedback: text,
      });
      onSuccess?.();
    } catch (cause) {
      setAgentStarting(false);
      setError(cause instanceof Error ? cause.message : "Agent failed");
    }
  };
  const send = () => void sendFeedback(feedback(), () => setFeedback(""));
  const submitComments = () =>
    void sendFeedback(
      `Review comments:\n${comments()
        .map((comment) => `- On ${comment.target}: ${comment.body}`)
        .join("\n")}`,
      () => setComments([]),
    );
  const commit = async () => {
    const current = session();
    if (!current || busy()) return;
    setOperationBusy(true);
    setError("");
    try {
      setSession(await client.session.commit.mutate({ id: current.id }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Commit failed");
    } finally {
      setOperationBusy(false);
    }
  };
  const chooseFolder = async () => {
    if (busy()) return;
    setOperationBusy(true);
    setError("");
    try {
      const chosen = await client.workspace.chooseFolder.mutate();
      if (
        chosen &&
        !repositories().some((repository) => repository.root === chosen.root)
      ) {
        setRepositories((current) => [...current, chosen]);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not choose folder",
      );
    } finally {
      setOperationBusy(false);
    }
  };
  const addPath = (root: string) => {
    const clean = root.replace(/\/$/, "");
    const name = clean.split(/[\\/]/).at(-1) || "repository";
    if (!repositories().some((repository) => repository.root === clean)) {
      setRepositories((current) => [...current, { name, root: clean }]);
    }
  };
  const startWorkspace = async () => {
    if (busy() || repositories().length === 0) return;
    setOperationBusy(true);
    setError("");
    try {
      const configured = await client.workspace.configure.mutate({
        id: session()?.id,
        repositories: repositories(),
      });
      setRepositories([...configured.repositories]);
      setSession(configured.session);
      setWorkspaceOpen(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not open workspace",
      );
    } finally {
      setOperationBusy(false);
    }
  };
  const createSession = async () => {
    if (operationBusy()) return;
    setOperationBusy(true);
    setError("");
    try {
      const created = await client.session.create.mutate();
      setAgentStarting(false);
      setSession(created);
      setRepositories([]);
      setWorkspaceOpen(false);
      setComments([]);
      setSessionUrl(created.id, "push");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create session",
      );
    } finally {
      setOperationBusy(false);
    }
  };
  const archiveSession = async (id: string) => {
    if (operationBusy()) return;
    setOperationBusy(true);
    setError("");
    try {
      const remaining = await client.session.archive.mutate({ id });
      setSessions([...remaining]);
      if (session()?.id !== id) return;
      const next = remaining[0];
      if (next) {
        const opened = await client.session.open.query({ id: next.id });
        setSession(opened.session);
        setRepositories([...opened.repositories]);
        setWorkspaceOpen(opened.repositories.length > 0);
        setComments([]);
        setSessionUrl(next.id, "replace");
      } else {
        const created = await client.session.create.mutate();
        setSession(created);
        setRepositories([]);
        setWorkspaceOpen(false);
        setComments([]);
        setSessionUrl(created.id, "replace");
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not archive session",
      );
    } finally {
      setOperationBusy(false);
    }
  };
  return (
    <Switch>
      <Match when={!session()}>
        <div class="loading">
          <div class="mark">hy</div>
          <p>{error() || "Opening the change room…"}</p>
        </div>
      </Match>
      <Match when={session()}>
        {(loaded) => (
          <div class="session-shell">
            <SessionSidebar
              sessions={sessions()}
              activeId={loaded().id}
              disabled={operationBusy()}
              select={(id) => void openSession(id, "push")}
              create={() => void createSession()}
              archive={(id) => void archiveSession(id)}
            />
            <section class="session-stage">
              <Show
                when={!shouldShowWorkspacePicker(workspaceOpen())}
                fallback={
                  <WorkspacePicker
                    repositories={repositories()}
                    busy={busy()}
                    error={error()}
                    chooseFolder={() => void chooseFolder()}
                    addPath={addPath}
                    updateName={(index, name) =>
                      setRepositories((current) =>
                        current.map((repository, repositoryIndex) =>
                          repositoryIndex === index
                            ? { ...repository, name }
                            : repository,
                        ),
                      )
                    }
                    remove={(index) =>
                      setRepositories((current) =>
                        current.filter(
                          (_, repositoryIndex) => repositoryIndex !== index,
                        ),
                      )
                    }
                    start={() => void startWorkspace()}
                  />
                }
              >
                <VariantA
                  session={loaded()}
                  feedback={feedback()}
                  busy={busy()}
                  agentConfigured={agentConfigured()}
                  error={error()}
                  comments={comments()}
                  following={following()}
                  setFeedback={setFeedback}
                  addComment={(target, body) =>
                    setComments((current) => [
                      ...current,
                      { id: crypto.randomUUID(), target, body },
                    ])
                  }
                  submitComments={submitComments}
                  toggleFollowing={() => setFollowing((current) => !current)}
                  send={send}
                  commit={commit}
                />
              </Show>
            </section>
          </div>
        )}
      </Match>
    </Switch>
  );
}

render(() => <App />, document.getElementById("root")!);
