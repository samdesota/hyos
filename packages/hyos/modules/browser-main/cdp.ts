import type { CdpEndpoint, CdpTarget } from "../../capabilities/browser.js";

type RawCdpTarget = Readonly<{
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  devtoolsFrontendUrl?: unknown;
  webSocketDebuggerUrl?: unknown;
}>;

const string = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * Resolve a discovered target's devtools frontend to an absolute HTTP(S) URL
 * the browser host can load. Chrome and Electron report relative paths like
 * `/devtools/inspector.html?ws=host:port/devtools/page/<id>`; absolute
 * `http(s)://` urls pass through unchanged.
 */
export function resolveCdpFrontendUrl(
  endpoint: CdpEndpoint,
  target: CdpTarget,
): string {
  const frontend = target.devtoolsFrontendUrl;
  if (!frontend) {
    throw new Error(
      `CDP target "${target.title || target.id}" exposes no devtools frontend`,
    );
  }
  const origin = `http://${endpoint.host}:${endpoint.port}`;
  if (frontend.startsWith("/")) return `${origin}${frontend}`;
  if (/^https?:\/\//i.test(frontend)) return frontend;
  throw new Error(`Unsupported devtools frontend URL: ${frontend}`);
}

/**
 * Discover debug targets on a Chrome DevTools Protocol endpoint by fetching
 * its `GET /json/list` discovery API. Works for any CDP endpoint — a Chrome
 * started with `--remote-debugging-port`, or HyOS itself via
 * `HYOS_DEVTOOLS_PORT`.
 */
export async function listCdpTargets(
  endpoint: CdpEndpoint,
): Promise<readonly CdpTarget[]> {
  if (
    !Number.isInteger(endpoint.port) ||
    endpoint.port <= 0 ||
    endpoint.port > 65535
  ) {
    throw new Error(`Invalid CDP port: ${endpoint.port}`);
  }
  const url = `http://${endpoint.host}:${endpoint.port}/json/list`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    throw new Error(
      `Could not reach CDP endpoint ${endpoint.host}:${endpoint.port}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(
      `CDP endpoint ${endpoint.host}:${endpoint.port} responded ${response.status}`,
    );
  }
  const list: unknown = await response.json();
  if (!Array.isArray(list)) {
    throw new Error("Unexpected CDP discovery response (expected a list)");
  }
  return (list as readonly RawCdpTarget[]).map((target) => ({
    id: string(target.id),
    type: string(target.type),
    title: string(target.title),
    url: string(target.url),
    devtoolsFrontendUrl:
      typeof target.devtoolsFrontendUrl === "string"
        ? target.devtoolsFrontendUrl
        : null,
    webSocketDebuggerUrl:
      typeof target.webSocketDebuggerUrl === "string"
        ? target.webSocketDebuggerUrl
        : null,
  }));
}
