# Agent module design

## Goal

Add a first-class coding-agent surface to HyOS. A user lands on a new-session
screen, chooses a folder and model, enters a prompt, and starts a session. A
persistent sidebar lists sessions and switches the active transcript.

The implementation must support more than one agent harness without exposing
provider-specific behavior to the renderer. The first intended adapters are:

- Codex through the Codex API and harness; and
- Claude through the Claude Agent SDK and the user's Claude authentication.

The first pass covers session creation, session switching, text messages, live
status/output, cancellation, and persistence. Tool inspection, approvals, diffs,
and richer activity are later extensions.

## Module shape

The feature is split across the Electron process seam:

```text
renderer                                      main process

agent.renderer ── commands + subscriptions ──▶ agent.main
      │                                           │
      ├── session summaries                       ├── HyDB
      └── active message feed                     ├── Codex adapter
                                                  └── Claude adapter
```

### `agent.main`

Lives in `modules/agent-main/` and runs in the main process. It:

- owns the HyDB database and all persisted agent state;
- owns the lifecycle of running harness turns;
- exposes typed commands, session summaries, and scoped message feeds;
- opens the native folder picker; and
- selects a provider adapter from manifest configuration.

Its provided same-process interface is `agent.sessions`. That interface is also its
test surface. Electron, HyDB query mechanics, remote transport, and provider SDK
objects remain private implementation details.

### `agent.renderer`

Lives in `modules/agent-renderer/` and runs in the renderer process. It:

- consumes the remote agent capability;
- keeps only the currently loaded transcript window in memory;
- derives Solid state from backend subscriptions;
- renders the session sidebar, welcome/new-session page, and transcript; and
- sends user commands back to `agent.main`.

For the first pass it becomes the single owner of the existing `#app` mount, replacing
`browser.renderer` in the application manifest. Two renderer modules must not mount
independent Solid roots into the same element. The browser modules remain separate
and can later be composed by an application-shell renderer module when HyOS needs
top-level navigation between Browser and Agent.

Both modules are placed and configured only in `application.manifest.ts`. Their
entrypoints stay thin; model, storage, provider, synchronization, and UI details live
in focused private files beside each entrypoint.

## Backend interfaces

The renderer sends actions that require backend authority through a small command
interface:

```ts
type AgentCommand =
  | { type: "choose-folder" }
  | {
      type: "start-session";
      prompt: string;
      folder: string;
      providerId: string;
      modelId: string;
    }
  | { type: "send-message"; sessionId: string; prompt: string }
  | { type: "cancel"; sessionId: string };
```

`choose-folder` returns a selected path or `null`; it does not mutate session state.
Starting a session, sending a message, and cancelling a run commit their resulting
state to the authoritative database. Their responses contain acknowledgements or
identifiers, not replacement copies of session state.

Session summaries are small, so the backend publishes the complete ordered list when
that query changes. Message history uses a separate paged and incremental interface:

```ts
type MessageChange =
  | { type: "message-created"; sequence: number; message: AgentMessage }
  | {
      type: "content-appended";
      sequence: number;
      messageId: string;
      chunkIndex: number;
      content: string;
    }
  | {
      type: "message-status";
      sequence: number;
      messageId: string;
      status: MessageStatus;
      error?: string;
    };

type MessageFeed = Readonly<{
  initial: MessagePage;
  subscribe(listener: (change: MessageChange) => void): () => void;
  close(): void;
}>;

interface AgentSessions {
  execute(command: AgentCommand): Promise<AgentCommandResult>;
  subscribeSessions(listener: (sessions: SessionSummary[]) => void): () => void;
  openMessageFeed(input: {
    sessionId: string;
    newestCount: number;
  }): Promise<MessageFeed>;
  loadOlderMessages(input: {
    sessionId: string;
    before: MessageCursor;
    count: number;
  }): Promise<MessagePage>;
}
```

`openMessageFeed` returns the newest page in chronological order and starts a scoped
subscription for later changes. The backend buffers changes that race with the initial
page, so the renderer cannot miss a message between loading and subscribing. Closing
or switching a session disposes that feed. The renderer client hides any transport
feed ID used to multiplex remote events.

Older pages use a stable keyset cursor `(createdAt, id)`, never an offset. Page size is
bounded by both message count and encoded bytes so a few unusually large messages do
not create an unbounded IPC payload. Pages assemble stored chunks into renderer message
values; the incremental feed keeps later chunks separate on the wire.

The selected session remains renderer-local navigation state rather than persisted
domain state.

## Provider seam

Codex and Claude vary at one private backend seam:

```ts
interface AgentProvider {
  readonly id: string;
  listModels(): Promise<readonly AgentModel[]>;
  run(
    input: AgentRunInput,
    events: AgentRunEvents,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
}
```

`AgentRunInput` contains the normalized prompt, folder, model ID, and optional opaque
provider session ID for continuation. `AgentRunEvents` accepts normalized assistant
text and status updates. `AgentRunResult` returns the provider session ID needed for
the next turn.

There will be two real adapters at this seam, not provider conditionals spread through
session orchestration. Each adapter owns SDK construction, authentication discovery,
provider event translation, and resume semantics. Provider session IDs are opaque to
the rest of the module. Provider availability errors appear in model metadata and do
not prevent the other adapter from working. Secrets and access tokens are never
persisted in HyDB or sent to the renderer.

The first UI can group models by provider while storing `providerId` and `modelId`
separately. A saved session always continues through its original provider unless a
future migration feature explicitly changes it.

## HyDB model

HyDB is the sole source of truth for sessions and transcripts.

### `agent_sessions`

- `id`
- `title` (initially derived from the first prompt)
- `folder`
- `providerId`
- `modelId`
- `providerSessionId` (nullable and opaque)
- `status`: `running | ready | failed | cancelled`
- `lastError` (nullable, safe user-facing text)
- `createdAt`
- `updatedAt`

### `agent_messages`

- `id`
- `sessionId`
- `role`: `user | assistant | system`
- `status`: `streaming | complete | failed`
- `lastError` (nullable)
- `createdAt`
- `updatedAt`

### `agent_message_chunks`

- `id`
- `messageId`
- `index`
- `content`
- `createdAt`

Messages are ordered by `(createdAt, id)` and chunks by `(messageId, index)`. Starting
a session atomically inserts the session, initial user message, and its content chunk
before the provider is invoked. Assistant streaming appends bounded chunks rather than
rewriting an ever-growing message row. The final update changes only message status.
This avoids quadratic persistence and IPC traffic for long responses.

Provider-native event payloads are deliberately not stored in the first pass. When
tool calls and approvals are added, introduce a normalized activity model rather than
placing provider JSON in the transcript.

## Realtime synchronization

HyDB remains entirely in the main process. The backend uses HyDB subscriptions to
maintain the small session-summary stream and to drive each open message feed. The
renderer receives domain events, not database transactions or full transcript
snapshots.

```text
user command
    │
    ▼
agent.main transaction ──▶ HyDB commit
                              │
                              ▼
                     HyDB subscriptions
                              │
                  ┌───────────┴────────────┐
                  ▼                        ▼
          session summaries       active message changes
                  │                        │
                  └───────────▶ Solid signals
```

Each message feed has a monotonically increasing sequence. The renderer applies a
change once and requests a fresh newest page if it detects a gap. `content-appended`
contains only the new chunk, never the message's accumulated content. Completion and
failure are separate small status events.

Commands do not push bespoke optimistic session state in the first pass. Database
writes from commands, provider output, failures, and cancellation all reach the UI
through the subscription interfaces.

On hot reload or shutdown, `ctx.effect` disposes the HyDB subscriptions, remote
message feeds, remote provider, active adapter runs, timers used for output batching,
and the database in reverse order. A run interrupted by process shutdown is marked
failed or cancelled on the next startup rather than remaining permanently `running`.

## UI first pass

The renderer uses a two-column layout:

- A fixed sidebar contains a **New session** action and sessions ordered by
  `updatedAt` descending. Each row shows title, model, and current status.
- With no active session, the main pane shows a welcome heading, prompt composer,
  folder picker, provider/model selector, and start button.
- An active session initially loads the newest message page and anchors the transcript
  at the bottom.
- Scrolling upward fetches and prepends older keyset pages while preserving the
  visible scroll position.
- A bottom-oriented virtual list mounts only visible messages plus a small overscan;
  loaded but offscreen messages do not retain expensive Markdown DOM.
- New chunks extend the active assistant message. The view follows them only when the
  user is already near the bottom; reading older content is never interrupted.
- The active session includes a composer for the next message.
- Running sessions show live assistant text and a cancel action.
- Empty, unavailable-provider, folder-selection, and run errors are rendered inline
  and remain understandable after reload.

The form remains an unpersisted renderer draft until `start-session` succeeds. This
avoids filling the sidebar with abandoned sessions.

## Manifest configuration

The root manifest controls placement, storage location, and enabled adapters. A
representative shape is:

```ts
{
  id: "agent.main",
  file: "./modules/agent-main/index.ts",
  host: "main",
  reload: "hot",
  config: {
    storagePath: ".data/hyos-agent",
    providers: ["codex", "claude"],
  },
}
```

Configuration identifies adapters but does not contain credentials. Model discovery
comes from the adapters so the renderer does not hard-code provider inventories.

## Verification

The first implementation is complete when:

1. sessions and messages survive an Electron restart;
2. the sidebar follows backend session-summary subscriptions without loading message
   bodies;
3. starting, streaming, completing, failing, and cancelling a fake provider run update
   the active message feed through incremental changes;
4. provider contract tests run the same session scenarios against fake Codex and
   Claude adapters;
5. opening a transcript transfers only the newest bounded page, scrolling upward
   preserves viewport position, and a long streaming reply transfers only new chunks;
6. feed setup cannot lose changes racing with its initial page, and sequence gaps
   trigger recovery;
7. every listener, feed, database, timer, and active run has a disposer;
8. `npm run check --workspace @hyos/hyos` passes; and
9. the Electron smoke test covers initial load, session creation, module reload, and
   shutdown cleanup.

## Deferred decisions

- tool-call and approval presentation;
- worktree creation versus operating in the selected checkout;
- filesystem access policy beyond the selected folder;
- transcript compaction and provider context limits;
- diff/review artifacts;
- session archive/delete behavior; and
- an application-shell module that composes Browser and Agent navigation.

These should be added only when their behavior is exercised. They do not need to
expand the first-pass session interface now.
