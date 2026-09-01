# Hyagent design

## Goal

Hyagent's output is a **literate diff**: a document the agent writes while it works.
It begins with a high-level overview, then develops into prose, diagrams, and code
patches. The explanation and implementation are one live artifact, so the engineer
can review and redirect the work before it is finished.

A single literate diff may span multiple repositories.

The document is not a plan followed by hidden implementation. It is the agent's
working surface.

## Core primitives

### Live document

The literate diff contains:

1. an overview of the intended change;
2. an ordered body of prose, optional diagrams, and patch blocks; and
3. an optional footer of generated worktree changes excluded from the patch.

A patch block has a stable identity, repository, title, explanation, and ordered
create, replace, or delete operations. Its explanation preserves the intent when its
code needs to change. The UI derives a familiar diff from those operations; unified
diff text is not executable state.

The document may be incomplete while the agent is working. Hydb persists each update
and the UI renders it immediately.

### Patch stacks

Each repository has an ordered patch stack applied to its current worktree. The
document can interleave blocks from different repositories into one narrative.

When an earlier patch changes, the runtime rewinds that repository to it and reapplies
its later patches. Replay stops at the first patch that fails; the agent repairs that
patch and continues. Patches in other repositories are unaffected. Later document
blocks remain in place instead of being regenerated.

```text
patch A ── patch B ── patch C ── patch D
              │
          revise B
              │
patch A ── patch B² ── replay C ── replay D
                            │
                     stop if C fails
```

Replay is a runtime guarantee. Its implementation is deliberately unspecified.

### Worktree consistency

A run records each repository's current worktree as its baseline, including changes
already present. As the agent works, the loop checks that later worktree changes in
every repository are represented by the literate diff.

Unrecorded changes are returned as an error and included as a warning in the next
model invocation. The agent can resolve them by:

- incorporating them into a patch block; or
- marking generated paths as intentionally ignored, with a short reason.

Ignored generated changes remain visible at the bottom of the document. They do not
modify `.gitignore`.

This check should compare the current worktree diff with the composed literate diff.
It must remain cheap and run in the current worktree.

## Agent tools

The first version needs three model-facing tools:

```ts
read_file(repo, path);
run_command(repo, command, args);
edit_literate_diff(operations);
```

- `read_file` reads a repository's current worktree.
- `run_command` runs a bounded command in the selected repository's current worktree.
  Search, tests, builds, formatters, and generators all use the same tool. Validation
  is not a special phase.
- `edit_literate_diff` adds, replaces, moves, or removes document blocks and generated
  ignores. Patch and ignore operations identify their repository. Patch edits
  synchronize that repository's stack and return the first replay failure.

There is no model-facing `apply_patch` tool. Code changes enter through the literate
diff.

## Agent loop

```text
thread + literate diff + worktree warnings
                    │
                    ▼
                  model
                    │
      read file / run command / edit document
                    │
                    ▼
       persist document and check consistency
                    │
                    └──────────────▶ next model invocation
```

The initial prompt tells the agent to start with an overview and develop the change
inside the document. After that, the agent decides how to investigate, explain, patch,
validate, and backtrack. The loop does not encode those choices as a workflow.

Thread messages and submitted document comments join the next model context. Because
the document persists independently of a model turn, the user can watch it change and
respond while the agent works.

## System shape

- **Hydb** stores the thread, participating repositories, live document, comments, and
  document history.
- **The agent server** runs the model loop, tools, patch replay, and consistency check.
- **tRPC** handles non-database actions such as starting, stopping, and accepting.
- **The UI** presents the thread and document in two columns.

## Document presentation

The literate diff should read like a normal dark technical document. It uses semantic
titles and regular body copy, without paragraph markers or block-type labels. Patches
are syntax highlighted, omit git metadata, show a few context lines, collapse distant
unchanged regions, and use one line-number gutter. Files can collapse or expand to the
full file. File headings identify both repository and path. Users can follow live
edits and submit inline comments as a batch.

## Deliberately unspecified

The POC does not prescribe validation stages, a state machine, a second worktree,
checkpoint storage, replay internals, streaming granularity, or final commit policy.
This includes cross-repository commit coordination. Those decisions should be added
only when the working prototype demonstrates a need.
