import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSessionTab,
  AgentSessionTabs,
} from "../../capabilities/agent.js";
import type { TabId } from "../../capabilities/browser.js";
import { createSessionTabsRecorder } from "./session-tabs.js";

const entry = (tabId: string, url: string): AgentSessionTab => ({
  kind: "browser",
  tabId,
  url,
});

type Save = { tabs: AgentSessionTabs | null };

function harness(options: {
  saved?: AgentSessionTabs | null;
  visible?: readonly AgentSessionTab[];
}) {
  const saves: Save[] = [];
  let record = options.saved ?? null;
  const recorder = createSessionTabsRecorder({
    load: async () => record,
    save: async (_sessionId, tabs) => {
      record = tabs;
      saves.push({ tabs });
    },
    visibleTabs: () => options.visible ?? [],
  });
  return { recorder, saves, record: () => record };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

test("opened appends the tab, focuses it, and skips an id already recorded", async () => {
  const { recorder, saves } = harness({});
  recorder.opened("session-1", "tab-1" as TabId, "https://a.example/");
  await settle();
  recorder.opened("session-1", "tab-1" as TabId, "https://a.example/");
  await settle();
  assert.deepEqual(saves, [
    {
      tabs: { tabs: [entry("tab-1", "https://a.example/")], activeIndex: 0 },
    },
  ]);
});

test("closed removes the entry, falls focus to the next tab, and nulls an empty strip", async () => {
  const { recorder, saves } = harness({
    saved: {
      tabs: [
        entry("tab-1", "https://a.example/"),
        entry("tab-2", "https://b.example/"),
      ],
      activeIndex: 0,
    },
  });
  recorder.closed("session-1", "tab-1" as TabId);
  await settle();
  assert.deepEqual(saves, [
    {
      tabs: { tabs: [entry("tab-2", "https://b.example/")], activeIndex: 0 },
    },
  ]);
  recorder.closed("session-1", "tab-2" as TabId);
  await settle();
  assert.deepEqual(saves[1], { tabs: null });
  // Closing an unknown tab writes nothing.
  recorder.closed("session-1", "tab-9" as TabId);
  await settle();
  assert.equal(saves.length, 2);
});

test("focused moves the saved focus and skips no-op or unknown focuses", async () => {
  const { recorder, saves } = harness({
    saved: {
      tabs: [
        entry("tab-1", "https://a.example/"),
        entry("tab-2", "https://b.example/"),
      ],
      activeIndex: 0,
    },
  });
  recorder.focused("session-1", "tab-2" as TabId);
  await settle();
  recorder.focused("session-1", "tab-2" as TabId);
  await settle();
  recorder.focused("session-1", "tab-9" as TabId);
  await settle();
  assert.deepEqual(saves, [
    {
      tabs: {
        tabs: [
          entry("tab-1", "https://a.example/"),
          entry("tab-2", "https://b.example/"),
        ],
        activeIndex: 1,
      },
    },
  ]);
});

test("resolved binds record entries to the host tab ids a projection found", async () => {
  const { recorder, saves } = harness({
    saved: {
      tabs: [
        entry("tab-1", "https://a.example/"),
        entry("tab-2", "https://b.example/"),
      ],
      activeIndex: 0,
    },
  });
  // The projection adopted a live tab for the first entry (its persisted id
  // was stale) and could not resolve the second.
  recorder.resolved("session-1", ["tab-7" as TabId, null]);
  await settle();
  assert.deepEqual(saves, [
    {
      tabs: {
        tabs: [
          entry("tab-7", "https://a.example/"),
          entry("tab-2", "https://b.example/"),
        ],
        activeIndex: 0,
      },
    },
  ]);
  // Nothing changed: no write.
  recorder.resolved("session-1", ["tab-7" as TabId, null]);
  await settle();
  assert.equal(saves.length, 1);
});

test("a delta composes onto the record merged with the visible strip — an empty record we did not cause cannot erase visible tabs", async () => {
  // Regression: a wiped or never-restored record (tabs=0) used to become the
  // base for the next write, dropping the session's visible tabs from
  // durability. The visible strip is part of the base instead.
  const { recorder, saves } = harness({
    saved: null,
    visible: [
      entry("tab-1", "https://a.example/"),
      entry("tab-2", "https://b.example/"),
    ],
  });
  recorder.opened("session-1", "tab-3" as TabId, "https://c.example/");
  await settle();
  assert.deepEqual(saves, [
    {
      tabs: {
        tabs: [
          entry("tab-1", "https://a.example/"),
          entry("tab-2", "https://b.example/"),
          entry("tab-3", "https://c.example/"),
        ],
        activeIndex: 2,
      },
    },
  ]);
});

test("a visible tab with a stale recorded id heals the record entry by url", async () => {
  const { recorder, saves } = harness({
    saved: { tabs: [entry("tab-1", "https://a.example/")], activeIndex: 0 },
    visible: [entry("tab-7", "https://a.example/")],
  });
  recorder.focused("session-1", "tab-7" as TabId);
  await settle();
  assert.deepEqual(saves, [
    { tabs: { tabs: [entry("tab-7", "https://a.example/")], activeIndex: 0 } },
  ]);
});

test("a failed load or save swallows the delta; a failed write leaves the record untouched", async () => {
  let down = true;
  const saves: Save[] = [];
  let record: AgentSessionTabs | null = null;
  const recorder = createSessionTabsRecorder({
    load: async () => {
      if (down) throw new Error("host unavailable");
      return record;
    },
    save: async (_sessionId, tabs) => {
      record = tabs;
      saves.push({ tabs });
    },
    visibleTabs: () => [],
  });
  recorder.opened("session-1", "tab-1" as TabId, "https://a.example/");
  await settle();
  assert.equal(saves.length, 0);
  down = false;
  recorder.opened("session-1", "tab-1" as TabId, "https://a.example/");
  await settle();
  assert.deepEqual(saves, [
    { tabs: { tabs: [entry("tab-1", "https://a.example/")], activeIndex: 0 } },
  ]);
});
