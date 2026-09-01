# hyagent POC

`hyagent` is a server-side coding agent that works through a live literate diff: an
ordered document of prose, optional diagrams, and patches. Document edits persist as
the model works, and patch blocks synchronize the current worktree immediately.

See [DESIGN.md](./DESIGN.md) for the minimal design.

## Run

```sh
AI_GATEWAY_API_KEY=... npm run dev:hyagent
```

The launcher prefers <http://127.0.0.1:5184/> with the agent server on port
`4328`. If either port is occupied, it automatically advances to an available port
and prints both selected URLs. Set `HYAGENT_CLIENT_PORT` or `HYAGENT_PORT` to choose
different preferred starting ports; occupied overrides advance in the same way.

Set `PARALLEL_API_KEY` alongside the gateway key to enable the agent's `web_search`
and `web_fetch` tools. Search returns a bounded set of relevant sources and excerpts;
fetch reads up to ten selected pages as focused or full Markdown content.

Each prompt has an agent selector, including on the new-task page. The selection
applies to that turn and is remembered per thread, so a thread can switch models
between messages without resetting on reload. The default is
`anthropic/claude-sonnet-4.5` unless `HYAGENT_MODEL` overrides it.

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
document. The Commit control verifies consistency, generates repository-specific
messages, lets the reviewer edit them, and creates real Git commits for the paths
represented by the document.

Committing closes only the current literate diff, not the thread. New feedback in a
committed thread starts a fresh diff from the committed worktree state; earlier diffs
remain available as read-only document tabs.

Repositories may provide an executable root-level `yeet.sh` for their own merge or
delivery workflow. Yeet is disabled when no selected repository has the script;
otherwise it runs each available hook from that repository's root. If the worktree
is dirty, Yeet opens the editable commit-message control as “Commit & Yeet.” Files
covered by generated-ignore entries are included in that commit. Unaccounted changes
disable the combined action and appear in its tooltip; the hook runs only after the
literate diff is committed and the worktree is clean.
