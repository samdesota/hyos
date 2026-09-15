/**
 * Hash routes. The hash fragment is the app's URL: `/` is the new-session
 * view, `/session/:id` opens a session, `/tabs/:id` focuses a global tab,
 * and `/archive` opens archived sessions. Anything unrecognized resolves to `/` so a stale or hand-edited
 * hash can never blank the app.
 */
export type AppRoute =
  | Readonly<{ kind: "new" }>
  | Readonly<{ kind: "session"; sessionId: string }>
  | Readonly<{ kind: "global-tabs"; tabId: string }>
  | Readonly<{ kind: "archive" }>;

const ROUTE_PREFIX = "#";
const SESSION_ROUTE = "/session/";
const TABS_ROUTE = "/tabs/";
const ARCHIVE_ROUTE = "/archive";

/** Router paths (without the hash prefix) for each AppRoute kind. */
export const ROUTE_PATHS = {
  new: "/",
  session: "/session/:id",
  globalTabs: "/tabs/:id",
  archive: ARCHIVE_ROUTE,
} as const;

/** Route kinds, mirroring AppRoute's `kind` discriminant. */
export type RouteKind = AppRoute["kind"];

/**
 * AppRoute for a matched router route and its raw `:id` param. Router
 * params arrive percent-encoded, matching how `routeFromHash` decodes
 * them; an absent/empty id falls back to the new-session view.
 */
export function routeFromParams(
  kind: RouteKind,
  id: string | undefined,
): AppRoute {
  switch (kind) {
    case "session":
      return id
        ? { kind: "session", sessionId: decodeURIComponent(id) }
        : { kind: "new" };
    case "global-tabs":
      return id
        ? { kind: "global-tabs", tabId: decodeURIComponent(id) }
        : { kind: "new" };
    case "new":
      return { kind: "new" };
    case "archive":
      return { kind: "archive" };
  }
}

/** The route encoded in the URL hash; unrecognized hashes read as `/`. */
export function routeFromHash(hash: string = window.location.hash): AppRoute {
  if (!hash.startsWith(ROUTE_PREFIX)) return { kind: "new" };
  const path = hash.slice(ROUTE_PREFIX.length);
  if (path.startsWith(SESSION_ROUTE) && path.length > SESSION_ROUTE.length) {
    return {
      kind: "session",
      sessionId: decodeURIComponent(path.slice(SESSION_ROUTE.length)),
    };
  }
  if (path.startsWith(TABS_ROUTE) && path.length > TABS_ROUTE.length) {
    return {
      kind: "global-tabs",
      tabId: decodeURIComponent(path.slice(TABS_ROUTE.length)),
    };
  }
  if (path === ARCHIVE_ROUTE) return { kind: "archive" };
  return { kind: "new" };
}

/** Hash fragment that routes to the given route. */
export function hashForRoute(route: AppRoute): string {
  switch (route.kind) {
    case "session":
      return `${ROUTE_PREFIX}${SESSION_ROUTE}${encodeURIComponent(route.sessionId)}`;
    case "global-tabs":
      return `${ROUTE_PREFIX}${TABS_ROUTE}${encodeURIComponent(route.tabId)}`;
    case "archive":
      return `${ROUTE_PREFIX}${ARCHIVE_ROUTE}`;
    case "new":
      return `${ROUTE_PREFIX}/`;
  }
}
