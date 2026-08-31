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

The UI opens with an overview when no gateway key is configured, but agent feedback
requires the key.

## Multiple repositories

The default workspace contains this repository as `hyos`. Configure more repositories
with a JSON name-to-path map:

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
