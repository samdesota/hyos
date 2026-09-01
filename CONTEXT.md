# Hyagent

Hyagent develops a proposed code change as a live, reviewable document while working
across one or more repository worktrees.

## Language

**Literate diff**:
The live document containing the intent, explanation, and ordered code changes for one
piece of agent work.
_Avoid_: Plan, report, final diff

**Workspace**:
The repositories participating in one literate diff.
_Avoid_: Monorepo, checkout

**Patch block**:
One explained code change targeting one repository and containing ordered file
operations within a literate diff.
_Avoid_: Edit, apply_patch call

**File operation**:
One structured `create_file`, `replace_text`, or `delete_file` instruction inside a
patch block. Unified diff syntax is a generated review view, not stored executable
state.
_Avoid_: Hunk, raw patch

**Patch stack**:
The ordered patch blocks represented in one repository's worktree.
_Avoid_: Patch list, changes array

**Replay**:
Reapplying later patch blocks after an earlier patch block changes, stopping at the
first patch that fails.
_Avoid_: Regeneration, restart

**Baseline**:
One repository's worktree state, including existing changes, when a run begins.
_Avoid_: Clean checkout, dedicated worktree

**Unrecorded change**:
A worktree change made after the baseline that is not represented by the literate
diff.
_Avoid_: Dirty file, stray change

**Generated-file ignore**:
A visible declaration that a generated worktree change is intentionally excluded from
the patch stack.
_Avoid_: Gitignore entry, hidden change
