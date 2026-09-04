import {
  UI_AGENT_DISPOSE_EVENT,
  UI_AGENT_FRAME_ID,
  UI_AGENT_LAUNCHER_ID,
} from "./protocol.js";

export interface AttachUiAgentOptions {
  serverUrl: string;
  document?: Document;
  mode?: "iframe" | "embedded";
}

function normalizeServerUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Attach the UI-agent overlay to a browser document without requiring Vite. */
export function attachUiAgent(options: AttachUiAgentOptions): () => void {
  const document = options.document ?? globalThis.document;
  const window = document.defaultView;
  if (!window) throw new Error("UI agent requires a browser window");

  const script = document.createElement("script");
  script.type = "module";
  const source = new URL(`${normalizeServerUrl(options.serverUrl)}/client.js`);
  source.searchParams.set("instance", crypto.randomUUID());
  if (options.mode === "embedded") source.searchParams.set("mode", "embedded");
  script.src = source.href;
  script.dataset.hyosUiAgent = "";
  document.body.append(script);

  return () => {
    window.dispatchEvent(new Event(UI_AGENT_DISPOSE_EVENT));
    script.remove();
    document.getElementById(UI_AGENT_FRAME_ID)?.remove();
    document.getElementById(UI_AGENT_LAUNCHER_ID)?.remove();
  };
}
