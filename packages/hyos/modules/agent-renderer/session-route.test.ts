import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTE_PATHS,
  hashForRoute,
  hashForSession,
  routeFromHash,
  routeFromParams,
  sessionFromHash,
} from "./session-route.js";

test("hash routes resolve to the three route kinds", () => {
  // `/` — the empty hash, a bare fragment, an explicit slash, and anything
  // unrecognized all read as the new-session view.
  assert.deepEqual(routeFromHash(""), { kind: "new" });
  assert.deepEqual(routeFromHash("#"), { kind: "new" });
  assert.deepEqual(routeFromHash("#/"), { kind: "new" });
  assert.deepEqual(routeFromHash("#/other"), { kind: "new" });
  // `/session/:id` — decoded, and only when an id is present.
  assert.deepEqual(routeFromHash("#/session/session-1"), {
    kind: "session",
    sessionId: "session-1",
  });
  assert.deepEqual(routeFromHash("#/session/ses%2Fsion"), {
    kind: "session",
    sessionId: "ses/sion",
  });
  assert.deepEqual(routeFromHash("#/session/"), { kind: "new" });
  // `/tabs/:id` — a global tab page.
  assert.deepEqual(routeFromHash("#/tabs/global-tab-1"), {
    kind: "global-tabs",
    tabId: "global-tab-1",
  });
  assert.deepEqual(routeFromHash("#/tabs/tab%2F1"), {
    kind: "global-tabs",
    tabId: "tab/1",
  });
  assert.deepEqual(routeFromHash("#/tabs/"), { kind: "new" });
});

test("router paths mirror the AppRoute kinds", () => {
  assert.deepEqual(ROUTE_PATHS, {
    new: "/",
    session: "/session/:id",
    globalTabs: "/tabs/:id",
  });
});

test("route params map back onto the AppRoute model", () => {
  assert.deepEqual(routeFromParams("new", undefined), { kind: "new" });
  assert.deepEqual(routeFromParams("session", "session-1"), {
    kind: "session",
    sessionId: "session-1",
  });
  // Params arrive percent-encoded, as the router stores them.
  assert.deepEqual(routeFromParams("session", "ses%2Fsion"), {
    kind: "session",
    sessionId: "ses/sion",
  });
  assert.deepEqual(routeFromParams("global-tabs", "tab%2F1"), {
    kind: "global-tabs",
    tabId: "tab/1",
  });
  // Missing or empty ids fall back to the new-session view, like a
  // `/session/` hash would.
  assert.deepEqual(routeFromParams("session", undefined), { kind: "new" });
  assert.deepEqual(routeFromParams("global-tabs", ""), { kind: "new" });
});

test("hash routes round-trip", () => {
  assert.equal(hashForRoute({ kind: "new" }), "#/");
  assert.equal(
    hashForRoute({ kind: "session", sessionId: "session-1" }),
    "#/session/session-1",
  );
  assert.equal(
    hashForRoute({ kind: "global-tabs", tabId: "tab/1" }),
    "#/tabs/tab%2F1",
  );
  for (const route of [
    { kind: "new" },
    { kind: "session", sessionId: "ses/sion" },
    { kind: "global-tabs", tabId: "tab/1" },
  ] as const) {
    assert.deepEqual(routeFromHash(hashForRoute(route)), route);
  }
});

test("session helpers keep working against the route union", () => {
  assert.equal(hashForSession(null), "");
  assert.equal(hashForSession("session-1"), "#/session/session-1");
  assert.equal(sessionFromHash("#/session/session-1"), "session-1");
  assert.equal(sessionFromHash("#/tabs/global-tab-1"), null);
  assert.equal(sessionFromHash("#/other"), null);
  assert.equal(sessionFromHash(""), null);
});
