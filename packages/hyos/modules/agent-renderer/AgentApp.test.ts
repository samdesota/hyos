import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentMessage,
  AgentSessionSummary,
} from "../../capabilities/agent.js";
import {
  collapseWorkRuns,
  duplicateFolderNames,
  folderName,
  foldersByRecentUse,
  folderPathPrefix,
  groupSessionsByFolder,
  implementNextPrompt,
  nextPlanTask,
  orderedFolderGroups,
  orderedFolders,
  partitionSessions,
  planPanelIndex,
  recentFolders,
  timelineEntries,
  truncatePathStart,
  workPaneLabel,
} from "./sessions-model.js";
import { resizedPatchPanelWidth } from "./patch-panel.js";
import { agentStyles } from "./styles.js";

function sessionSummary(
  id: string,
  archivedAt: Date | null,
): AgentSessionSummary {
  const now = new Date("2026-09-04T00:00:00.000Z");
  return {
    id,
    title: id,
    folder: "/tmp/project",
    originFolder: null,
    providerId: "codex",
    modelId: "gpt-5.6-sol",
    reasoningEffort: null,
    mode: "standard",
    plan: null,
    status: "ready",
    statusDetail: null,
    seenStatusDetail: null,
    lastError: null,
    archivedAt,
    createdAt: now,
    updatedAt: now,
  };
}

test("sessions are partitioned into active and archived lists", () => {
  const sessions = [
    sessionSummary("live-1", null),
    sessionSummary("archived-1", new Date("2026-09-03T10:00:00.000Z")),
    sessionSummary("live-2", null),
  ];

  assert.deepEqual(partitionSessions(sessions), {
    active: [sessions[0], sessions[2]],
    archived: [sessions[1]],
  });
});

test("folder groups preserve newest-first input order without mutating sessions", () => {
  const sessions = Object.freeze([
    Object.freeze({ ...sessionSummary("newest", null), folder: "/tmp/beta" }),
    Object.freeze({ ...sessionSummary("middle", null), folder: "/tmp/alpha" }),
    Object.freeze({ ...sessionSummary("oldest", null), folder: "/tmp/beta" }),
  ]);
  assert.deepEqual(groupSessionsByFolder(sessions), [
    {
      folder: "/tmp/beta",
      label: "beta",
      parentPath: null,
      sessions: [sessions[0], sessions[2]],
    },
    {
      folder: "/tmp/alpha",
      label: "alpha",
      parentPath: null,
      sessions: [sessions[1]],
    },
  ]);
  assert.deepEqual(groupSessionsByFolder([]), []);
});

test("folder groups use exact paths and disambiguate duplicate names", () => {
  const paths = [
    "/projects/app",
    "/worktrees/app",
    "/projects/app/",
    "/projects/app/src",
  ];
  const groups = groupSessionsByFolder(
    paths.map((folder, index) => ({
      ...sessionSummary(String(index), null),
      folder,
    })),
  );
  assert.deepEqual(
    groups.map(({ folder, label, parentPath }) => ({
      folder,
      label,
      parentPath,
    })),
    [
      { folder: paths[0], label: "app", parentPath: "/projects" },
      { folder: paths[1], label: "app", parentPath: "/worktrees" },
      { folder: paths[2], label: "app", parentPath: "/projects" },
      { folder: paths[3], label: "src", parentPath: null },
    ],
  );
});

test("folder groups label empty and root folders", () => {
  const groups = groupSessionsByFolder(
    ["", "/"].map((folder) => ({
      ...sessionSummary(folder, null),
      folder,
    })),
  );
  assert.deepEqual(
    groups.map(({ folder, label, parentPath }) => ({
      folder,
      label,
      parentPath,
    })),
    [
      { folder: "", label: "No project folder", parentPath: null },
      { folder: "/", label: "/", parentPath: null },
    ],
  );
});

test("active and archived folder groups remain separate", () => {
  const live = sessionSummary("live", null);
  const archived = sessionSummary("archived", new Date());
  const other = {
    ...sessionSummary("other", new Date()),
    folder: "/elsewhere/project",
  };
  const partitions = partitionSessions([archived, live, other]);
  const activeGroups = groupSessionsByFolder(partitions.active);
  const archivedGroups = groupSessionsByFolder(partitions.archived);
  assert.deepEqual(activeGroups, [
    {
      folder: live.folder,
      label: "project",
      parentPath: null,
      sessions: [live],
    },
  ]);
  assert.deepEqual(
    archivedGroups.map((group) => group.sessions),
    [[archived], [other]],
  );
  assert.deepEqual(
    archivedGroups.map((group) => group.parentPath),
    ["/tmp", "/elsewhere"],
  );
});

test("recent folders are deduplicated in session order", () => {
  const folder = (path: string): AgentSessionSummary => ({
    ...sessionSummary("session", null),
    folder: path,
  });

  assert.deepEqual(recentFolders([]), []);
  assert.deepEqual(
    recentFolders([
      folder("/tmp/alpha"),
      folder("/tmp/beta"),
      folder("/tmp/alpha"),
      folder("/tmp/gamma"),
    ]),
    ["/tmp/alpha", "/tmp/beta", "/tmp/gamma"],
  );
});

test("foldersByRecentUse orders folders by their most recent session", () => {
  const folder = (path: string, base: number): AgentSessionSummary => ({
    ...sessionSummary("session", null),
    folder: path,
    updatedAt: new Date(base),
  });
  const base = Date.parse("2026-09-04T00:00:00.000Z");

  assert.deepEqual(foldersByRecentUse([]), []);
  assert.deepEqual(
    foldersByRecentUse([
      folder("/tmp/alpha", base),
      folder("/tmp/beta", base + 5_000),
      folder("/tmp/alpha", base + 10_000), // alpha's latest beats beta
      folder("/tmp/gamma", base - 1_000),
    ]),
    ["/tmp/alpha", "/tmp/beta", "/tmp/gamma"],
  );
});

test("orderedFolders respects the saved order and appends new folders", () => {
  const recent = ["/tmp/alpha", "/tmp/beta", "/tmp/gamma"];

  assert.deepEqual(orderedFolders(recent, null), recent);
  assert.deepEqual(orderedFolders(recent, []), recent);
  assert.deepEqual(orderedFolders(recent, ["/tmp/gamma", "/tmp/alpha"]), [
    "/tmp/gamma",
    "/tmp/alpha",
    "/tmp/beta",
  ]);
  // Saved entries that no longer exist are dropped.
  assert.deepEqual(orderedFolders(recent, ["/tmp/gone", "/tmp/beta"]), [
    "/tmp/beta",
    "/tmp/alpha",
    "/tmp/gamma",
  ]);
  // Duplicate saved entries don't duplicate folders.
  assert.deepEqual(orderedFolders(recent, ["/tmp/alpha", "/tmp/alpha"]), [
    "/tmp/alpha",
    "/tmp/beta",
    "/tmp/gamma",
  ]);
});

test("orderedFolderGroups orders groups by the saved folder order", () => {
  const sessions = [
    { ...sessionSummary("a", null), folder: "/tmp/alpha" },
    { ...sessionSummary("b", null), folder: "/tmp/beta" },
    { ...sessionSummary("c", null), folder: "/tmp/gamma" },
  ];
  const groups = groupSessionsByFolder(sessions);
  const folders = (gs: typeof groups) => gs.map((g) => g.folder);

  // No saved order keeps the group order as-is.
  assert.deepEqual(folders(orderedFolderGroups(groups, null)), [
    "/tmp/alpha",
    "/tmp/beta",
    "/tmp/gamma",
  ]);
  assert.deepEqual(folders(orderedFolderGroups(groups, [])), [
    "/tmp/alpha",
    "/tmp/beta",
    "/tmp/gamma",
  ]);
  // Saved order wins; unsaved groups append in group order.
  assert.deepEqual(
    folders(orderedFolderGroups(groups, ["/tmp/gamma", "/tmp/alpha"])),
    ["/tmp/gamma", "/tmp/alpha", "/tmp/beta"],
  );
  // Saved entries that no longer exist are dropped, without duplicating.
  assert.deepEqual(
    folders(orderedFolderGroups(groups, ["/tmp/beta", "/tmp/gone"])),
    ["/tmp/beta", "/tmp/alpha", "/tmp/gamma"],
  );
  // A single saved entry moves that group to the front.
  assert.deepEqual(folders(orderedFolderGroups(groups, ["/tmp/beta"])), [
    "/tmp/beta",
    "/tmp/alpha",
    "/tmp/gamma",
  ]);
});

test("folderName extracts the basename of a folder path", () => {
  assert.equal(folderName("/Users/sam/projects/hyos"), "hyos");
  assert.equal(folderName("/Users/sam/projects/hyos/"), "hyos");
  assert.equal(folderName("hyos"), "hyos");
});

test("folderPathPrefix returns the parent path of a folder", () => {
  assert.equal(
    folderPathPrefix("/Users/sam/projects/hyos"),
    "/Users/sam/projects",
  );
  assert.equal(
    folderPathPrefix("/Users/sam/projects/hyos/"),
    "/Users/sam/projects",
  );
  assert.equal(folderPathPrefix("hyos"), "");
});

test("duplicateFolderNames finds names used by multiple folder paths", () => {
  const duplicates = duplicateFolderNames([
    "/Users/sam/work/hyos",
    "/Users/sam/Documents/ChatGPT/hyos",
    "/tmp/other",
  ]);
  assert.deepEqual([...duplicates], ["hyos"]);
  assert.deepEqual([...duplicateFolderNames(["/tmp/a", "/tmp/b"])], []);
});

test("truncatePathStart keeps the path tail and marks the cut", () => {
  const path = "/Users/sam/Documents/ChatGPT/projects/nested/very-long-folder";
  const truncated = truncatePathStart(path, 20);
  assert.equal(truncated.length, 20);
  assert.ok(truncated.startsWith("…"));
  assert.ok(path.endsWith(truncated.slice(1)));
  assert.equal(truncatePathStart("/short/path", 20), "/short/path");
});

test("terminal assistant failures remain visible without response text", () => {
  const now = new Date();
  const failed: AgentMessage = {
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    status: "failed",
    content: "",
    activity: null,
    lastError: "Patch explanation was missing.",
    usage: null,
    createdAt: now,
    updatedAt: now,
  };

  assert.deepEqual(timelineEntries([failed]), [
    { type: "message", message: failed },
  ]);
});

test("live message arrival order cannot place thinking after the final response", () => {
  const thinking: AgentMessage = {
    id: "thinking-1",
    sessionId: "session-1",
    role: "assistant",
    status: "complete",
    content: "Inspecting the implementation",
    activity: { type: "commentary", text: "Inspecting the implementation" },
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:00.000Z"),
    updatedAt: new Date("2026-09-03T12:00:01.000Z"),
  };
  const finalResponse: AgentMessage = {
    id: "final-1",
    sessionId: "session-1",
    role: "assistant",
    status: "complete",
    content: "Implemented the requested change.",
    activity: null,
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:02.000Z"),
    updatedAt: new Date("2026-09-03T12:00:02.000Z"),
  };

  assert.deepEqual(timelineEntries([finalResponse, thinking]), [
    { type: "message", message: thinking },
    { type: "message", message: finalResponse },
  ]);
});

test("consecutive commentary messages merge into a single timeline entry", () => {
  const base = {
    sessionId: "session-1",
    role: "assistant" as const,
    lastError: null,
    usage: null,
  };
  const first: AgentMessage = {
    ...base,
    id: "thinking-1",
    status: "complete",
    content: "Reading the renderer",
    activity: { type: "commentary", text: "Reading the renderer" },
    createdAt: new Date("2026-09-03T12:00:00.000Z"),
    updatedAt: new Date("2026-09-03T12:00:01.000Z"),
  };
  const second: AgentMessage = {
    ...base,
    id: "thinking-2",
    status: "streaming",
    content: "Now editing the styles",
    activity: { type: "commentary", text: "Now editing the styles" },
    createdAt: new Date("2026-09-03T12:00:02.000Z"),
    updatedAt: new Date("2026-09-03T12:00:03.000Z"),
  };

  const [merged] = timelineEntries([first, second]);
  assert.equal(merged.type, "message");
  if (merged.type !== "message") return;
  assert.equal(merged.message.id, "thinking-2");
  assert.equal(merged.message.status, "streaming");
  assert.equal(merged.message.createdAt, first.createdAt);
  assert.deepEqual(merged.message.activity, {
    type: "commentary",
    text: "Reading the renderer\n\nNow editing the styles",
  });
});

test("finished runs collapse thinking into a work pane before the final response", () => {
  const thinking: AgentMessage = {
    id: "thinking-1",
    sessionId: "session-1",
    role: "assistant",
    status: "complete",
    content: "Inspecting the implementation",
    activity: { type: "commentary", text: "Inspecting the implementation" },
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:00.000Z"),
    updatedAt: new Date("2026-09-03T12:00:01.000Z"),
  };
  const finalResponse: AgentMessage = {
    id: "final-1",
    sessionId: "session-1",
    role: "assistant",
    status: "complete",
    content: "Implemented the requested change.",
    activity: null,
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:32.000Z"),
    updatedAt: new Date("2026-09-03T12:00:32.000Z"),
  };
  const timeline = collapseWorkRuns(timelineEntries([thinking, finalResponse]));

  assert.deepEqual(timeline, [
    {
      type: "work",
      entries: [{ type: "message", message: thinking }],
      startedAt: thinking.createdAt,
      endedAt: finalResponse.createdAt,
    },
    { type: "message", message: finalResponse },
  ]);
  assert.equal(
    workPaneLabel(thinking.createdAt, finalResponse.createdAt),
    "Worked for 32s",
  );
});

test("streaming thinking stays inline until the run completes", () => {
  const thinking: AgentMessage = {
    id: "thinking-1",
    sessionId: "session-1",
    role: "assistant",
    status: "streaming",
    content: "Inspecting the implementation",
    activity: { type: "commentary", text: "Inspecting the implementation" },
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:00.000Z"),
    updatedAt: new Date("2026-09-03T12:00:01.000Z"),
  };
  const finalResponse: AgentMessage = {
    id: "final-1",
    sessionId: "session-1",
    role: "assistant",
    status: "streaming",
    content: "",
    activity: null,
    lastError: null,
    usage: null,
    createdAt: new Date("2026-09-03T12:00:32.000Z"),
    updatedAt: new Date("2026-09-03T12:00:32.000Z"),
  };
  const timeline = collapseWorkRuns(timelineEntries([thinking, finalResponse]));

  assert.deepEqual(timeline, [
    { type: "message", message: thinking },
    { type: "message", message: finalResponse },
  ]);
});

test("the plan panel sits below the final response, even with later turns", () => {
  const now = new Date();
  const message = (overrides: Partial<AgentMessage>): AgentMessage => ({
    id: crypto.randomUUID(),
    sessionId: "session-1",
    role: "assistant",
    status: "complete",
    content: "",
    activity: null,
    lastError: null,
    usage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const base = Date.now();
  const thinking = message({
    content: "Inspecting the implementation",
    activity: { type: "commentary", text: "Inspecting the implementation" },
    createdAt: new Date(base),
    updatedAt: new Date(base),
  });
  const finalResponse = message({
    content: "Step done.",
    createdAt: new Date(base + 1_000),
    updatedAt: new Date(base + 1_000),
  });
  const userFollowUp = message({
    role: "user",
    content: "continue",
    createdAt: new Date(base + 2_000),
    updatedAt: new Date(base + 2_000),
  });

  const entries = collapseWorkRuns(
    timelineEntries([thinking, finalResponse, userFollowUp]),
  );
  const finalIndex = entries.findIndex(
    (entry) => entry.type === "message" && entry.message === finalResponse,
  );
  assert.equal(planPanelIndex(entries), finalIndex);
  assert.notEqual(planPanelIndex(entries), entries.length - 1);
  assert.equal(planPanelIndex([{ type: "tools", messages: [thinking] }]), -1);
});

test("the plan panel attaches nothing while the agent is still streaming", () => {
  const now = new Date();
  const message = (overrides: Partial<AgentMessage>): AgentMessage => ({
    id: crypto.randomUUID(),
    sessionId: "session-1",
    role: "assistant",
    status: "streaming",
    content: "",
    activity: null,
    lastError: null,
    usage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const thinking = message({
    content: "Inspecting the implementation",
    activity: { type: "commentary", text: "Inspecting the implementation" },
  });
  const streamingResponse = message({ content: "Working…" });

  // Mid-run, thinking/commentary and the streaming response stay uncollapsed
  // message entries; none of them may host the plan panel.
  const entries = collapseWorkRuns(
    timelineEntries([thinking, streamingResponse]),
  );
  assert.equal(planPanelIndex(entries), -1);
  assert.equal(planPanelIndex([{ type: "message", message: thinking }]), -1);
});

test("implement next targets the first pending task", () => {
  const tasks = [
    { text: "Plan format + prompt policy", done: true },
    { text: "Plan parser", done: false },
    { text: "Plan UI", done: false },
  ];

  assert.deepEqual(nextPlanTask(tasks), tasks[1]);
  assert.equal(nextPlanTask(tasks.filter((task) => task.done)), null);
  assert.match(
    implementNextPrompt(1, tasks[1]),
    /only task 2 of the plan — "Plan parser"/,
  );
});

test("locked diffs let wheel scrolling reach the patch list", () => {
  const lockedRule = agentStyles.match(/^\s*\.diff-body\s*\{[^}]*\}/m)?.[0];
  assert.ok(lockedRule);
  assert.match(lockedRule, /overflow-y:\s*hidden/);
  assert.doesNotMatch(lockedRule, /overscroll-behavior:\s*contain/);
});

test("markdown tables are bordered and scroll horizontally", () => {
  const tableRule = agentStyles.match(/^\s*\.markdown table\s*\{[^}]*\}/m)?.[0];
  assert.ok(tableRule);
  assert.match(tableRule, /overflow-x:\s*auto/);
  assert.match(tableRule, /max-width:\s*100%/);

  const cellRule = agentStyles.match(
    /^\s*\.markdown th, \.markdown td\s*\{[^}]*\}/m,
  )?.[0];
  assert.ok(cellRule);
  assert.match(cellRule, /border:\s*1px solid/);
  assert.match(cellRule, /padding:/);

  const headRule = agentStyles.match(
    /^\s*\.markdown thead th\s*\{[^}]*\}/m,
  )?.[0];
  assert.ok(headRule);
  assert.match(headRule, /background:/);
  assert.match(headRule, /white-space:\s*nowrap/);

  // Default header alignment must not override micromark's align="" attributes.
  const alignRule = agentStyles.match(
    /^\s*\.markdown th:not\(\[align\]\)\s*\{[^}]*\}/m,
  )?.[0];
  assert.ok(alignRule);
});

test("patch resizing uses the conversation width instead of the panel width", () => {
  const conversation = { clientWidth: 1_100 };
  const divider = {
    closest(selector: string) {
      return selector === ".conversation" ? conversation : null;
    },
  };

  assert.equal(
    resizedPatchPanelWidth({
      divider,
      fallbackWidth: 1_100,
      startWidth: 520,
      startX: 600,
      currentX: 500,
    }),
    620,
  );
});
