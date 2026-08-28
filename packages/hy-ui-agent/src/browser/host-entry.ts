import html2canvasModule from "html2canvas";

import type {
  ElementSelection,
  QuickIterationRequest,
} from "../agent-types.js";
import { UI_AGENT_FRAME_ID } from "../protocol.js";
import type {
  HostToOverlayMessage,
  HostMessagePayload,
  OverlayToHostMessage,
  RestoredIteration,
  ScreenshotCapture,
  SelectionRegion,
} from "./messages.js";
import { normalizeClonedDocumentColors } from "./normalize-colors.js";
import {
  ingestFrontendLogs,
  runIteration,
  undoIteration,
} from "./trpc-client.js";

const FRAME_ID = UI_AGENT_FRAME_ID;
const LAUNCHER_ID = "hyos-ui-agent-launcher";
const SOURCE_ATTRIBUTE = "data-source-loc";
const SESSION_KEY = "hyos-ui-agent-iteration";
const html2canvas = html2canvasModule as unknown as (
  element: HTMLElement,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
    logging: boolean;
    useCORS: boolean;
    backgroundColor: string;
    ignoreElements(element: Element): boolean;
    onclone(document: Document): void;
  },
) => Promise<HTMLCanvasElement>;
const scriptUrl = new URL(import.meta.url);
const overlayUrl = new URL("./overlay", scriptUrl);

interface SelectionContext {
  region: SelectionRegion;
  elements: ElementSelection[];
  screenshot?: ScreenshotCapture;
}

interface PersistedIteration extends RestoredIteration {
  request: QuickIterationRequest;
}

type FrontendLog = Parameters<typeof ingestFrontendLogs>[0][number];

function readPersistedIteration(): PersistedIteration | undefined {
  try {
    const value = sessionStorage.getItem(SESSION_KEY);
    return value ? (JSON.parse(value) as PersistedIteration) : undefined;
  } catch {
    return undefined;
  }
}

function persistIteration(iteration: PersistedIteration | undefined): void {
  try {
    if (iteration)
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(iteration));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // The overlay still works when browser storage is unavailable.
  }
}

let persistedIteration = readPersistedIteration();
let currentContext: SelectionContext | undefined = persistedIteration?.context;
let frontendLogs: FrontendLog[] = [];
let flushingLogs = false;
let resuming = false;

function serializeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "string") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function queueFrontendLog(
  level: FrontendLog["level"],
  event: string,
  values: unknown[],
  requestId?: string,
): void {
  frontendLogs.push({
    level,
    event,
    message: values
      .map((value) =>
        typeof value === "string"
          ? value
          : JSON.stringify(serializeLogValue(value)),
      )
      .join(" ")
      .slice(0, 20_000),
    timestamp: Date.now(),
    requestId,
    data: { url: location.href },
  });
  if (frontendLogs.length > 500) frontendLogs = frontendLogs.slice(-500);
}

async function flushFrontendLogs(): Promise<void> {
  if (flushingLogs || frontendLogs.length === 0) return;
  flushingLogs = true;
  const entries = frontendLogs.splice(0, 100);
  try {
    await ingestFrontendLogs(entries);
  } catch {
    frontendLogs.unshift(...entries);
  } finally {
    flushingLogs = false;
  }
}

for (const level of ["debug", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...values: unknown[]) => {
    original(...values);
    queueFrontendLog(level, `console.${level}`, values);
  };
}
window.addEventListener("error", (event) => {
  queueFrontendLog("error", "window.error", [event.error ?? event.message]);
});
window.addEventListener("unhandledrejection", (event) => {
  queueFrontendLog("error", "window.unhandledrejection", [event.reason]);
});
window.setInterval(() => void flushFrontendLogs(), 1_000);
queueFrontendLog("info", "telemetry.started", ["Frontend telemetry connected"]);

function frame(): HTMLIFrameElement | undefined {
  const candidate = document.getElementById(FRAME_ID);
  return candidate instanceof HTMLIFrameElement ? candidate : undefined;
}

function launcher(): HTMLButtonElement | undefined {
  const candidate = document.getElementById(LAUNCHER_ID);
  return candidate instanceof HTMLButtonElement ? candidate : undefined;
}

function postToOverlay(message: HostMessagePayload): void {
  frame()?.contentWindow?.postMessage(
    { source: "hyos-ui-agent-host", ...message },
    overlayUrl.origin,
  );
}

function setOverlayActive(active: boolean): void {
  const overlay = frame();
  if (!overlay) return;
  overlay.style.pointerEvents = active ? "auto" : "none";
  overlay.setAttribute("aria-hidden", String(!active));
  const trigger = launcher();
  if (trigger) {
    trigger.hidden = active;
    trigger.style.setProperty("display", active ? "none" : "flex", "important");
  }
}

function beginQuickEdit(): void {
  persistedIteration = undefined;
  persistIteration(undefined);
  currentContext = undefined;
  setOverlayActive(true);
  postToOverlay({ type: "start-region-selection" });
}

function mountOverlay(): void {
  if (!frame()) {
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
  if (!launcher()) {
    const trigger = document.createElement("button");
    trigger.id = LAUNCHER_ID;
    trigger.type = "button";
    trigger.setAttribute("aria-label", "Start quick edit (Hyper E)");
    trigger.innerHTML =
      '<span>Quick edit</span><kbd style="padding:4px 7px;border:1px solid rgb(255 255 255 / 12%);border-radius:999px;color:#fff;background:rgb(255 255 255 / 9%);font:650 10px ui-sans-serif,system-ui">Hyper E</kbd>';
    trigger.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:7px 8px 7px 11px",
      "border:1px solid rgb(255 255 255 / 14%)",
      "border-radius:999px",
      "color:rgb(255 255 255 / 72%)",
      "background:rgb(17 17 19 / 88%)",
      "box-shadow:0 8px 30px rgb(0 0 0 / 24%)",
      "font:11px ui-sans-serif,system-ui",
      "cursor:pointer",
      "z-index:2147483646",
    ].join(";");
    trigger.addEventListener("click", beginQuickEdit);
    document.documentElement.append(trigger);
  }
  if (persistedIteration) setOverlayActive(true);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function intersects(rect: DOMRect, region: SelectionRegion): boolean {
  return (
    rect.right > region.x &&
    rect.left < region.x + region.width &&
    rect.bottom > region.y &&
    rect.top < region.y + region.height
  );
}

function cssPath(element: HTMLElement): string {
  const parts: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      part += `#${CSS.escape(current.id)}`;
      parts.unshift(part);
      break;
    }
    const classes = Array.from(current.classList).slice(0, 2);
    if (classes.length > 0) {
      part += `.${classes.map((name) => CSS.escape(name)).join(".")}`;
    }
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function usefulAttributes(element: HTMLElement): Record<string, string> {
  const names = [
    "role",
    "type",
    "name",
    "aria-label",
    "href",
    "placeholder",
    "title",
  ];
  return Object.fromEntries(
    names
      .filter((name) => element.hasAttribute(name))
      .map((name) => [name, (element.getAttribute(name) ?? "").slice(0, 240)]),
  );
}

function elementContext(element: HTMLElement): ElementSelection {
  const rect = element.getBoundingClientRect();
  const text = (element.innerText || element.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
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
      ? { sourceHint: element.getAttribute(SOURCE_ATTRIBUTE) ?? undefined }
      : {}),
    boundingBox: {
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    },
  };
}

function collectElements(region: SelectionRegion): ElementSelection[] {
  const ignored = new Set([
    "HTML",
    "HEAD",
    "BODY",
    "SCRIPT",
    "STYLE",
    "LINK",
    "META",
    "NOSCRIPT",
  ]);
  const regionArea = Math.max(1, region.width * region.height);
  return Array.from(document.querySelectorAll<HTMLElement>("body *"))
    .filter((element) => {
      if (
        [FRAME_ID, LAUNCHER_ID].includes(element.id) ||
        ignored.has(element.tagName)
      ) {
        return false;
      }
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
      const leftArea = Math.max(
        1,
        left.getBoundingClientRect().width *
          left.getBoundingClientRect().height,
      );
      const rightArea = Math.max(
        1,
        right.getBoundingClientRect().width *
          right.getBoundingClientRect().height,
      );
      const leftHint = left.hasAttribute(SOURCE_ATTRIBUTE) ? -2 : 0;
      const rightHint = right.hasAttribute(SOURCE_ATTRIBUTE) ? -2 : 0;
      return (
        leftHint +
        Math.abs(Math.log(leftArea / regionArea)) -
        (rightHint + Math.abs(Math.log(rightArea / regionArea)))
      );
    })
    .slice(0, 60)
    .map(elementContext);
}

async function captureRegion(
  region: SelectionRegion,
): Promise<ScreenshotCapture> {
  const canvas = await html2canvas(document.documentElement, {
    x: region.x + window.scrollX,
    y: region.y + window.scrollY,
    width: region.width,
    height: region.height,
    scale: 1,
    logging: false,
    useCORS: true,
    backgroundColor:
      getComputedStyle(document.body).backgroundColor || "#ffffff",
    onclone: normalizeClonedDocumentColors,
    ignoreElements: (element: Element) =>
      [FRAME_ID, LAUNCHER_ID].includes(element.id),
  });
  let output = canvas;
  const maxDimension = 1_400;
  if (Math.max(canvas.width, canvas.height) > maxDimension) {
    const scale = maxDimension / Math.max(canvas.width, canvas.height);
    output = document.createElement("canvas");
    output.width = Math.round(canvas.width * scale);
    output.height = Math.round(canvas.height * scale);
    output
      .getContext("2d")
      ?.drawImage(canvas, 0, 0, output.width, output.height);
  }
  let dataUrl = output.toDataURL("image/jpeg", 0.76);
  if (dataUrl.length > 3_700_000) {
    dataUrl = output.toDataURL("image/jpeg", 0.52);
  }
  return { dataUrl, width: output.width, height: output.height };
}

async function prepareContext(region: SelectionRegion): Promise<void> {
  queueFrontendLog("info", "selection.started", [region]);
  const elements = collectElements(region);
  let screenshot: ScreenshotCapture | undefined;
  let captureError: string | undefined;
  try {
    screenshot = await captureRegion(region);
  } catch (error) {
    captureError = error instanceof Error ? error.message : "Screenshot failed";
    queueFrontendLog("warn", "selection.capture_failed", [captureError]);
  }
  currentContext = { region, elements, screenshot };
  queueFrontendLog("info", "selection.context_ready", [
    `${elements.length} elements`,
    screenshot ? "screenshot ready" : "screenshot unavailable",
  ]);
  postToOverlay({
    type: "selection-context-ready",
    region,
    elements,
    screenshot,
    captureError,
  });
}

async function submitIteration(
  instruction: string,
  requestId: string,
  model: string,
): Promise<void> {
  if (!currentContext) throw new Error("Select a region first");
  queueFrontendLog("info", "iteration.submitted", [instruction], requestId);
  const fallback: ElementSelection = {
    tagName: "region",
    boundingBox: currentContext.region,
  };
  const [selection = fallback, ...contextElements] = currentContext.elements;
  const request: QuickIterationRequest = {
    instruction,
    model,
    continuationId: persistedIteration?.result?.id,
    selection,
    contextElements,
    screenshot: currentContext.screenshot,
    mode: "apply",
  };
  persistedIteration = {
    context: {
      ...currentContext,
      screenshot: undefined,
    },
    instruction,
    model,
    requestId,
    request: { ...request, screenshot: undefined },
    status: "submitting",
  };
  persistIteration(persistedIteration);
  await completeIteration(persistedIteration, request);
}

async function completeIteration(
  iteration: PersistedIteration,
  request = iteration.request,
): Promise<void> {
  const result = await runIteration(iteration.requestId, request);
  if (persistedIteration?.requestId !== iteration.requestId) return;
  queueFrontendLog(
    "info",
    "iteration.completed",
    ["UI update received"],
    iteration.requestId,
  );
  persistedIteration = { ...iteration, status: "result", result };
  persistIteration(persistedIteration);
  postToOverlay({ type: "iteration-complete", result });
}

async function resumeIteration(): Promise<void> {
  if (!persistedIteration || resuming) return;
  if (persistedIteration.status === "submitting") {
    resuming = true;
    try {
      await completeIteration(persistedIteration);
    } finally {
      resuming = false;
    }
  } else if (
    persistedIteration.status === "undoing" &&
    persistedIteration.result
  ) {
    resuming = true;
    try {
      await undoCompletedIteration(persistedIteration.result.id);
    } finally {
      resuming = false;
    }
  }
}

async function undoCompletedIteration(id: string): Promise<void> {
  const iteration = persistedIteration;
  const result = iteration?.result;
  if (!iteration || !result || result.id !== id) {
    throw new Error("This change is no longer available to undo");
  }
  persistedIteration = { ...iteration, status: "undoing", result };
  persistIteration(persistedIteration);
  await undoIteration(id);
  if (persistedIteration?.requestId !== iteration.requestId) return;
  persistedIteration = { ...iteration, status: "undone", result };
  persistIteration(persistedIteration);
  postToOverlay({ type: "iteration-undone" });
}

window.addEventListener("keydown", (event) => {
  const overlay = frame();
  if (
    event.key === "Escape" &&
    overlay?.getAttribute("aria-hidden") === "false"
  ) {
    event.preventDefault();
    postToOverlay({ type: "cancel-overlay" });
    return;
  }
  if (
    event.repeat ||
    !event.ctrlKey ||
    !event.altKey ||
    !event.shiftKey ||
    !event.metaKey ||
    event.code !== "KeyE"
  ) {
    return;
  }
  event.preventDefault();
  beginQuickEdit();
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const overlay = frame();
  if (
    event.origin !== overlayUrl.origin ||
    event.source !== overlay?.contentWindow
  ) {
    return;
  }
  const message = event.data as OverlayToHostMessage;
  if (message.source !== "hyos-ui-agent") return;
  if (message.type === "overlay-ready") {
    if (persistedIteration) {
      postToOverlay({
        type: "restore-iteration",
        iteration: persistedIteration,
      });
      void resumeIteration().catch((error) =>
        postToOverlay({
          type:
            persistedIteration?.status === "undoing"
              ? "undo-error"
              : "iteration-error",
          message: error instanceof Error ? error.message : "Iteration failed",
        }),
      );
    }
  } else if (message.type === "region-selected" && message.region) {
    void prepareContext(message.region);
  } else if (
    message.type === "submit-iteration" &&
    message.instruction &&
    message.requestId
  ) {
    void submitIteration(
      message.instruction,
      message.requestId,
      message.model,
    ).catch((error) =>
      postToOverlay({
        type: "iteration-error",
        message: error instanceof Error ? error.message : "Iteration failed",
      }),
    );
  } else if (message.type === "undo-iteration" && message.id) {
    void undoCompletedIteration(message.id).catch((error) =>
      postToOverlay({
        type: "undo-error",
        message: error instanceof Error ? error.message : "Undo failed",
      }),
    );
  } else if (message.type === "close-overlay") {
    persistedIteration = undefined;
    persistIteration(undefined);
    currentContext = undefined;
    setOverlayActive(false);
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
} else {
  mountOverlay();
}
