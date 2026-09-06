import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  createSessionTabsPersister,
  type SessionTabsTarget,
} from "./session-tabs.js";

const savedTabs = (url: string): SessionTabsTarget => ({
  sessionId: "session-1",
  tabs: { tabs: [{ kind: "browser", url, title: url }], activeIndex: 0 },
});

function harness(save: (target: SessionTabsTarget) => Promise<void>) {
  let snapshot: SessionTabsTarget | null = null;
  const persister = createSessionTabsPersister({
    delay: 500,
    snapshot: () => snapshot,
    save,
  });
  return {
    persister,
    set: (next: SessionTabsTarget | null) => {
      snapshot = next;
    },
  };
}

// Drain the persister's save bookkeeping, which settles on microtasks —
// mock timers own setTimeout, so a timer-based sleep would never fire.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

test("a burst of publishes coalesces into one save taken at fire time", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    const { persister, set } = harness(async (target) => {
      writes.push(target);
    });
    set(savedTabs("https://a.example/"));
    persister.request();
    // The pane keeps changing while the write is pending; a second publish
    // must not stack a second timer either.
    set(savedTabs("https://b.example/"));
    persister.request();
    mock.timers.tick(499);
    assert.equal(writes.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(writes, [savedTabs("https://b.example/")]);
    await settle();
  } finally {
    mock.timers.reset();
  }
});

test("flush persists immediately and cancels the pending write", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    const { persister, set } = harness(async (target) => {
      writes.push(target);
    });
    set(savedTabs("https://a.example/"));
    persister.request();
    persister.flush();
    assert.deepEqual(writes, [savedTabs("https://a.example/")]);
    mock.timers.tick(1_000);
    assert.equal(writes.length, 1);
    await settle();
  } finally {
    mock.timers.reset();
  }
});

test("unchanged snapshots are skipped; a new session or content writes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    const { persister, set } = harness(async (target) => {
      writes.push(target);
    });
    set(savedTabs("https://a.example/"));
    persister.flush();
    await settle();
    persister.flush();
    await settle();
    assert.equal(writes.length, 1);

    set({ ...savedTabs("https://a.example/"), sessionId: "session-2" });
    persister.flush();
    await settle();
    set({ ...savedTabs("https://b.example/"), sessionId: "session-2" });
    persister.flush();
    await settle();
    assert.deepEqual(
      writes.map(({ sessionId, tabs }) => [sessionId, tabs?.tabs[0].url]),
      [
        ["session-1", "https://a.example/"],
        ["session-2", "https://a.example/"],
        ["session-2", "https://b.example/"],
      ],
    );
  } finally {
    mock.timers.reset();
  }
});

test("a null snapshot writes nothing, but a cleared pane still writes null", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    const { persister, set } = harness(async (target) => {
      writes.push(target);
    });
    // No active session: nothing to persist.
    set(null);
    persister.request();
    mock.timers.tick(1_000);
    assert.equal(writes.length, 0);

    // An active session whose browser tabs are all gone clears its row.
    set({ sessionId: "session-1", tabs: null });
    persister.flush();
    await settle();
    assert.deepEqual(writes, [{ sessionId: "session-1", tabs: null }]);
  } finally {
    mock.timers.reset();
  }
});

test("a failed save is swallowed and retried by the next flush", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    let down = true;
    const { persister, set } = harness(async (target) => {
      if (down) throw new Error("host unavailable");
      writes.push(target);
    });
    set(savedTabs("https://a.example/"));
    persister.flush();
    await settle();
    assert.equal(writes.length, 0);
    down = false;
    persister.flush();
    await settle();
    assert.deepEqual(writes, [savedTabs("https://a.example/")]);
  } finally {
    mock.timers.reset();
  }
});

test("dispose cancels a scheduled write without firing it", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: SessionTabsTarget[] = [];
    const { persister, set } = harness(async (target) => {
      writes.push(target);
    });
    set(savedTabs("https://a.example/"));
    persister.request();
    persister.dispose();
    mock.timers.tick(1_000);
    assert.equal(writes.length, 0);
  } finally {
    mock.timers.reset();
  }
});
