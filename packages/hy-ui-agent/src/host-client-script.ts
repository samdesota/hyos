import { UI_AGENT_FRAME_ID } from "./protocol.js";

export function renderHostClientScript(): string {
  return `
const FRAME_ID = ${JSON.stringify(UI_AGENT_FRAME_ID)};
const SOURCE_ATTRIBUTE = "data-source-loc";
const scriptUrl = new URL(document.currentScript?.src ?? import.meta.url);
const overlayUrl = new URL("./overlay", scriptUrl);
const screenshotLibraryUrl = new URL("./html2canvas.js", scriptUrl);
const iterationUrl = new URL("./trpc/iteration.run", scriptUrl);
let currentContext;
let screenshotter;

function frame() {
  const candidate = document.getElementById(FRAME_ID);
  return candidate instanceof HTMLIFrameElement ? candidate : undefined;
}

function postToOverlay(message) {
  frame()?.contentWindow?.postMessage(
    { source: "hyos-ui-agent-host", ...message },
    overlayUrl.origin,
  );
}

function setOverlayActive(active) {
  const overlay = frame();
  if (!overlay) return;
  overlay.style.pointerEvents = active ? "auto" : "none";
  overlay.setAttribute("aria-hidden", String(!active));
}

function mountOverlay() {
  if (frame()) return;
  const overlay = document.createElement("iframe");
  overlay.id = FRAME_ID;
  overlay.title = "HyOS UI agent";
  overlay.src = overlayUrl.href;
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "width:100vw",
    "height:100vh",
    "border:0",
    "background:transparent",
    "pointer-events:none",
    "z-index:2147483647",
  ].join(";");
  document.documentElement.append(overlay);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function intersects(rect, region) {
  return (
    rect.right > region.x &&
    rect.left < region.x + region.width &&
    rect.bottom > region.y &&
    rect.top < region.y + region.height
  );
}

function cssPath(element) {
  const parts = [];
  let current = element;
  while (current && current !== document.body && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      part += "#" + CSS.escape(current.id);
      parts.unshift(part);
      break;
    }
    const classes = Array.from(current.classList).slice(0, 2);
    if (classes.length) part += "." + classes.map((name) => CSS.escape(name)).join(".");
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function usefulAttributes(element) {
  const names = ["role", "type", "name", "aria-label", "href", "placeholder", "title"];
  return Object.fromEntries(
    names
      .filter((name) => element.hasAttribute(name))
      .map((name) => [name, (element.getAttribute(name) ?? "").slice(0, 240)]),
  );
}

function elementContext(element) {
  const rect = element.getBoundingClientRect();
  const text = (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
  return {
    tagName: element.tagName.toLowerCase(),
    ...(text ? { text: text.slice(0, 500) } : {}),
    ...(element.id ? { id: element.id } : {}),
    ...(element.classList.length
      ? { classNames: Array.from(element.classList).slice(0, 24) }
      : {}),
    attributes: usefulAttributes(element),
    cssPath: cssPath(element),
    ...(element.getAttribute(SOURCE_ATTRIBUTE)
      ? { sourceHint: element.getAttribute(SOURCE_ATTRIBUTE) }
      : {}),
    boundingBox: {
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    },
  };
}

function collectElements(region) {
  const ignored = new Set(["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"]);
  const regionArea = Math.max(1, region.width * region.height);
  return Array.from(document.querySelectorAll("body *"))
    .filter((element) => {
      if (!(element instanceof HTMLElement) || element.id === FRAME_ID || ignored.has(element.tagName))
        return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        rect.width > 1 &&
        rect.height > 1 &&
        intersects(rect, region)
      );
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftArea = Math.max(1, leftRect.width * leftRect.height);
      const rightArea = Math.max(1, rightRect.width * rightRect.height);
      const leftHint = left.hasAttribute(SOURCE_ATTRIBUTE) ? -2 : 0;
      const rightHint = right.hasAttribute(SOURCE_ATTRIBUTE) ? -2 : 0;
      const leftScore = leftHint + Math.abs(Math.log(leftArea / regionArea));
      const rightScore = rightHint + Math.abs(Math.log(rightArea / regionArea));
      return leftScore - rightScore;
    })
    .slice(0, 60)
    .map(elementContext);
}

async function captureRegion(region) {
  screenshotter ??= import(screenshotLibraryUrl.href).then((module) => module.default);
  const html2canvas = await screenshotter;
  const canvas = await html2canvas(document.documentElement, {
    x: region.x + window.scrollX,
    y: region.y + window.scrollY,
    width: region.width,
    height: region.height,
    scale: 1,
    logging: false,
    useCORS: true,
    backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
    ignoreElements: (element) => element.id === FRAME_ID,
  });
  let output = canvas;
  const maxDimension = 1_400;
  if (Math.max(canvas.width, canvas.height) > maxDimension) {
    const scale = maxDimension / Math.max(canvas.width, canvas.height);
    output = document.createElement("canvas");
    output.width = Math.round(canvas.width * scale);
    output.height = Math.round(canvas.height * scale);
    output.getContext("2d")?.drawImage(canvas, 0, 0, output.width, output.height);
  }
  let dataUrl = output.toDataURL("image/jpeg", 0.76);
  if (dataUrl.length > 3_700_000) dataUrl = output.toDataURL("image/jpeg", 0.52);
  return { dataUrl, width: output.width, height: output.height };
}

async function prepareContext(region) {
  const elements = collectElements(region);
  let screenshot;
  let captureError;
  try {
    screenshot = await captureRegion(region);
  } catch (error) {
    captureError = error instanceof Error ? error.message : "Screenshot failed";
  }
  currentContext = { region, elements, screenshot };
  postToOverlay({
    type: "selection-context-ready",
    region,
    elements,
    screenshot,
    captureError,
  });
}

async function submitIteration(instruction) {
  if (!currentContext) throw new Error("Select a region first");
  const fallback = {
    tagName: "region",
    boundingBox: currentContext.region,
  };
  const [selection = fallback, ...contextElements] = currentContext.elements;
  const response = await fetch(iterationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instruction,
      selection,
      contextElements,
      screenshot: currentContext.screenshot,
      mode: "apply",
    }),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(body.error?.json?.message ?? body.error?.message ?? "Iteration failed");
  }
  return body.result?.data?.json ?? body.result?.data;
}

window.addEventListener("keydown", (event) => {
  if (event.repeat || !event.altKey || !event.shiftKey || event.code !== "KeyA") return;
  event.preventDefault();
  currentContext = undefined;
  setOverlayActive(true);
  postToOverlay({ type: "start-region-selection" });
});

window.addEventListener("message", (event) => {
  const overlay = frame();
  if (event.origin !== overlayUrl.origin || event.source !== overlay?.contentWindow) return;
  if (event.data?.source !== "hyos-ui-agent") return;
  if (event.data.type === "overlay-ready") return;
  if (event.data.type === "region-selected") {
    void prepareContext(event.data.region);
    return;
  }
  if (event.data.type === "submit-iteration") {
    void submitIteration(event.data.instruction)
      .then((result) => postToOverlay({ type: "iteration-complete", result }))
      .catch((error) =>
        postToOverlay({
          type: "iteration-error",
          message: error instanceof Error ? error.message : "Iteration failed",
        }),
      );
    return;
  }
  if (event.data.type === "close-overlay") {
    currentContext = undefined;
    setOverlayActive(false);
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
} else {
  mountOverlay();
}
`.trimStart();
}
