const SESSION_ROUTE_PREFIX = "#/session/";

/** Session id encoded in the URL hash, if any. */
export function sessionFromHash(
  hash: string = window.location.hash,
): string | null {
  return hash.startsWith(SESSION_ROUTE_PREFIX) &&
    hash.length > SESSION_ROUTE_PREFIX.length
    ? decodeURIComponent(hash.slice(SESSION_ROUTE_PREFIX.length))
    : null;
}

/** Hash fragment that routes to the given session, or "" for no session. */
export function hashForSession(sessionId: string | null): string {
  return sessionId
    ? `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`
    : "";
}

export function syncHashToSession(sessionId: string | null): void {
  const next = hashForSession(sessionId);
  if (window.location.hash === next) return;
  if (!next) {
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    return;
  }
  history.replaceState(null, "", next);
}
