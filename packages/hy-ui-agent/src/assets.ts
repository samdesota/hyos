import { UI_AGENT_FRAME_ID } from "./protocol.js";

export function renderClientScript(): string {
  return `
const FRAME_ID = ${JSON.stringify(UI_AGENT_FRAME_ID)};
const scriptUrl = new URL(document.currentScript?.src ?? import.meta.url);
const overlayUrl = new URL("./overlay", scriptUrl);

function mountOverlay() {
  if (document.getElementById(FRAME_ID)) return;

  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.title = "HyOS UI agent";
  frame.src = overlayUrl.href;
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = [
    "position:fixed",
    "inset:0",
    "width:100vw",
    "height:100vh",
    "border:0",
    "background:transparent",
    "pointer-events:none",
    "z-index:2147483647",
  ].join(";");

  document.documentElement.append(frame);
}

window.addEventListener("message", (event) => {
  if (event.origin !== overlayUrl.origin) return;
  if (event.data?.source !== "hyos-ui-agent") return;

  const frame = document.getElementById(FRAME_ID);
  if (!(frame instanceof HTMLIFrameElement)) return;

  if (event.data.type === "set-pointer-events") {
    frame.style.pointerEvents = event.data.enabled ? "auto" : "none";
    frame.setAttribute("aria-hidden", String(!event.data.enabled));
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
} else {
  mountOverlay();
}
`.trimStart();
}

export function renderOverlayHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HyOS UI Agent</title>
    <style>
      :root {
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * { box-sizing: border-box; }

      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent;
      }

      .status {
        position: fixed;
        right: 16px;
        bottom: 16px;
        padding: 8px 11px;
        border: 1px solid rgb(255 255 255 / 14%);
        border-radius: 999px;
        color: rgb(255 255 255 / 72%);
        background: rgb(17 17 19 / 88%);
        box-shadow: 0 8px 30px rgb(0 0 0 / 24%);
        font-size: 12px;
        line-height: 1;
        backdrop-filter: blur(12px);
      }
    </style>
  </head>
  <body>
    <div class="status">UI agent connected</div>
    <script type="module">
      window.parent.postMessage(
        { source: "hyos-ui-agent", type: "overlay-ready" },
        "*",
      );
    </script>
  </body>
</html>`;
}
