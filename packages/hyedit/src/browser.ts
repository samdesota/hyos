import {
  HYEDIT_DISPOSE_EVENT,
  HYEDIT_FRAME_ID,
  HYEDIT_LAUNCHER_ID,
} from "./protocol.js";

export interface AttachHyeditOptions {
  serverUrl: string;
  document?: Document;
  mode?: "iframe" | "embedded";
}

function normalizeServerUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Attach the hyedit overlay to a browser document without requiring Vite. */
export function attachHyedit(options: AttachHyeditOptions): () => void {
  const document = options.document ?? globalThis.document;
  const window = document.defaultView;
  if (!window) throw new Error("hyedit requires a browser window");

  const script = document.createElement("script");
  script.type = "module";
  const source = new URL(`${normalizeServerUrl(options.serverUrl)}/client.js`);
  source.searchParams.set("instance", crypto.randomUUID());
  if (options.mode === "embedded") source.searchParams.set("mode", "embedded");
  script.src = source.href;
  script.dataset.hyosHyedit = "";
  document.body.append(script);

  return () => {
    window.dispatchEvent(new Event(HYEDIT_DISPOSE_EVENT));
    script.remove();
    document.getElementById(HYEDIT_FRAME_ID)?.remove();
    document.getElementById(HYEDIT_LAUNCHER_ID)?.remove();
  };
}
