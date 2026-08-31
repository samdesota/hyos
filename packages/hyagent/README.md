# hyagent POC

`hyagent` is a server-side coding agent that works through a live literate diff: an
ordered document of prose, optional diagrams, and patches. Document edits persist as
the model works, and patch blocks synchronize the current worktree immediately.

See [DESIGN.md](./DESIGN.md) for the minimal design.

## Run

```sh
AI_GATEWAY_API_KEY=... npm run dev:hyagent
```

Open <http://127.0.0.1:5184/>. The agent server runs on port `4328`.

The + button opens a new-task draft without creating a persisted session. Choose one
or more Git repositories, decide whether to use the selected checkouts or create
isolated worktrees, enter the initial prompt, and press Enter to start. The session is
persisted only after workspace preparation succeeds.

The new-task page remembers source repository folders from previous tasks, selects the
most recently used checkout by default, and exposes the rest in a dropdown. Managed
worktree paths are not added to this source-folder history.

Worktree mode creates a `hyagent/...` branch under `.data/hyagent-worktrees`. Files
listed in a repository's `.worktreeinclude` are copied into the new worktree. The
optional “Base off latest remote main” setting fetches `origin/main` and creates the
branch from that refreshed ref instead of local `HEAD`. The setting is disabled when
any selected repository has no `origin` remote; worktree creation then uses local
`HEAD` normally.

## Multiple repositories

Multiple repositories can be selected from the new-task screen. Servers can also
start with repository paths configured through a JSON name-to-path map:

```sh
HYAGENT_REPOSITORIES='{"web":"/projects/web","api":"/projects/api"}' \
  AI_GATEWAY_API_KEY=... npm run dev:hyagent
```

Each patch identifies its repository. Replay and worktree-consistency checks are
scoped per repository while all changes remain in one document.

## Shape

```text
two-column UI ──tRPC──▶ custom agent loop ──▶ read_file
       │                       │             run_command
       │                       └──────────── edit_literate_diff
       │                                      │
       └────────────────── hydb ◀─────────────┘
                                              │
                                 current repo worktrees
```

Hydb stores the thread, sessions, activity, and incremental document revisions. The
browser subscribes to that state over tRPC WebSockets. The agent server applies and
replays document patches, then checks for worktree changes not represented by the
document. Acceptance verifies consistency, asks AI for repository-specific commit
messages, and creates real Git commits for the paths represented by the document.
