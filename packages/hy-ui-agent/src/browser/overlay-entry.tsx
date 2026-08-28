import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createRoot } from "react-dom/client";

import type {
  AgentActivity,
  ElementSelection,
  QuickIterationResult,
} from "../agent-types.js";
import type {
  HostToOverlayMessage,
  OverlayToHostMessage,
  OverlayMessagePayload,
  ScreenshotCapture,
  SelectionRegion,
} from "./messages.js";
import { subscribeToIterationActivity } from "./trpc-client.js";
import "./overlay.css";

type Mode =
  "idle" | "selecting" | "collecting" | "prompt" | "submitting" | "result";

interface Context {
  elements: ElementSelection[];
  screenshot?: ScreenshotCapture;
  captureError?: string;
}

function post(message: OverlayMessagePayload): void {
  window.parent.postMessage({ source: "hyos-ui-agent", ...message }, "*");
}

function App() {
  const [mode, setMode] = useState<Mode>("idle");
  const [region, setRegion] = useState<SelectionRegion>();
  const [context, setContext] = useState<Context>();
  const [instruction, setInstruction] = useState("");
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<QuickIterationResult>();
  const dragStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const subscription = useRef<{ unsubscribe(): void } | undefined>(undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);

  function stopActivity() {
    subscription.current?.unsubscribe();
    subscription.current = undefined;
  }

  function close() {
    stopActivity();
    dragStart.current = undefined;
    setMode("idle");
    setRegion(undefined);
    setContext(undefined);
    setInstruction("");
    setActivities([]);
    setError("");
    setResult(undefined);
    post({ type: "close-overlay" });
  }

  function startSelection() {
    stopActivity();
    setMode("selecting");
    setRegion(undefined);
    setContext(undefined);
    setInstruction("");
    setActivities([]);
    setError("");
    setResult(undefined);
  }

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent) return;
      const message = event.data as HostToOverlayMessage;
      if (message?.source !== "hyos-ui-agent-host") return;
      if (message.type === "start-region-selection") startSelection();
      if (message.type === "cancel-overlay") close();
      if (message.type === "selection-context-ready") {
        setContext({
          elements: message.elements,
          screenshot: message.screenshot,
          captureError: message.captureError,
        });
        setMode("prompt");
        requestAnimationFrame(() => textarea.current?.focus());
      }
      if (message.type === "iteration-complete") {
        stopActivity();
        setResult(message.result);
        setMode("result");
      }
      if (message.type === "iteration-error") {
        stopActivity();
        setError(message.message);
        setMode("prompt");
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown);
    post({ type: "overlay-ready" });
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown);
      stopActivity();
    };
  }, []);

  useEffect(() => {
    if (mode !== "submitting") return;
    const started = performance.now();
    const timer = window.setInterval(
      () => setElapsed((performance.now() - started) / 1_000),
      100,
    );
    return () => window.clearInterval(timer);
  }, [mode]);

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (mode !== "selecting" || event.button !== 0) return;
    dragStart.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setRegion({ x: event.clientX, y: event.clientY, width: 1, height: 1 });
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    if (!start) return;
    setRegion({
      x: Math.min(start.x, event.clientX),
      y: Math.min(start.y, event.clientY),
      width: Math.abs(event.clientX - start.x),
      height: Math.abs(event.clientY - start.y),
    });
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    dragStart.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (!region || region.width < 8 || region.height < 8) return;
    setMode("collecting");
    post({ type: "region-selected", region });
  }

  function submit() {
    const value = instruction.trim();
    if (!value || mode !== "prompt") return;
    const requestId = crypto.randomUUID();
    setError("");
    setElapsed(0);
    setActivities([
      {
        phase: "context",
        message: "Sending selected region to agent",
        timestamp: Date.now(),
      },
    ]);
    setMode("submitting");
    subscription.current = subscribeToIterationActivity(requestId, {
      onData(activity) {
        setActivities((current) => [...current, activity]);
      },
      onError(activityError) {
        setActivities((current) => [
          ...current,
          {
            phase: "error",
            message:
              activityError instanceof Error
                ? activityError.message
                : "Activity connection lost",
            timestamp: Date.now(),
          },
        ]);
      },
      onComplete() {},
    });
    post({ type: "submit-iteration", instruction: value, requestId });
  }

  if (mode === "idle") return null;

  const elements = context?.elements ?? [];
  const sourceCount = new Set(
    elements.map((item) => item.sourceHint).filter(Boolean),
  ).size;
  const contextTitle =
    elements[0]?.text || elements[0]?.cssPath || "Selected region";

  return (
    <>
      {(mode === "selecting" || mode === "collecting") && (
        <div
          className={`selection-surface ${mode}`}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
        >
          {mode === "selecting" && (
            <div className="selection-tip">
              Drag around what you want to change <span>Esc to cancel</span>
            </div>
          )}
          {region && (
            <div
              className="selection-box"
              style={{
                left: region.x,
                top: region.y,
                width: region.width,
                height: region.height,
              }}
            >
              <div className="selection-label">
                {Math.round(region.width)} × {Math.round(region.height)}
              </div>
            </div>
          )}
        </div>
      )}

      {(mode === "collecting" ||
        mode === "prompt" ||
        mode === "submitting" ||
        mode === "result") && (
        <form
          className="prompt-panel"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="context-row">
            {context?.screenshot?.dataUrl && (
              <img
                className="capture-preview"
                src={context.screenshot.dataUrl}
                alt="Selected region"
              />
            )}
            <div className="context-copy">
              <strong>
                {mode === "collecting" ? "Collecting context…" : contextTitle}
              </strong>
              <span>
                {mode === "collecting"
                  ? "Inspecting elements and capturing region"
                  : `${elements.length} DOM elements · ${sourceCount} source locations · ${context?.captureError ? "screenshot unavailable" : "screenshot ready"}`}
              </span>
            </div>
            <button
              className="close-button"
              type="button"
              onClick={close}
              aria-label="Cancel"
            >
              ×
            </button>
          </div>

          {mode === "result" ? (
            <div className="result">
              <div className="result-mark">✓</div>
              <h2>Change applied</h2>
              <p>{result?.summary ?? "The selected UI was updated."}</p>
              <div className="prompt-actions">
                <span>
                  {result?.edits.length ?? 0}{" "}
                  {(result?.edits.length ?? 0) === 1
                    ? "file edit"
                    : "file edits"}
                </span>
                <button className="apply-button" type="button" onClick={close}>
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              <textarea
                ref={textarea}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="What should change in this region?"
                disabled={mode !== "prompt"}
                required
              />
              {error && <div className="error">{error}</div>}
              {mode === "submitting" && (
                <section className="activity" aria-live="polite">
                  <div className="activity-header">
                    <span>Agent activity</span>
                    <time>{elapsed.toFixed(1)}s</time>
                  </div>
                  <div className="activity-list">
                    {activities.map((item, index) => (
                      <div
                        className="activity-item"
                        key={`${item.phase}-${index}`}
                      >
                        <span className="activity-dot" />
                        <span>
                          {item.message}
                          {item.detail && (
                            <small className="activity-detail">
                              {item.detail}
                            </small>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <div className="prompt-actions">
                <span>Enter to apply · Shift Enter for a new line</span>
                <button
                  className="apply-button"
                  type="submit"
                  disabled={mode !== "prompt" || !instruction.trim()}
                >
                  {mode === "submitting" ? (
                    <>
                      <span className="spinner" />
                      Applying
                    </>
                  ) : error ? (
                    "Try again ↗"
                  ) : (
                    "Make change ↗"
                  )}
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Overlay root element not found");
createRoot(root).render(<App />);
