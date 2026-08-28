export function renderIterationOverlayHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HyOS UI Agent</title>
    <style>
      :root {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
      button, textarea { font: inherit; }
      button { cursor: pointer; }
      [hidden] { display: none !important; }

      .shortcut-pill {
        position: fixed;
        right: 16px;
        bottom: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 8px 7px 11px;
        border: 1px solid rgb(255 255 255 / 14%);
        border-radius: 999px;
        color: rgb(255 255 255 / 72%);
        background: rgb(17 17 19 / 88%);
        box-shadow: 0 8px 30px rgb(0 0 0 / 24%);
        font-size: 11px;
        backdrop-filter: blur(14px);
      }
      kbd {
        padding: 4px 7px;
        border: 1px solid rgb(255 255 255 / 12%);
        border-radius: 999px;
        color: #fff;
        background: rgb(255 255 255 / 9%);
        font-family: inherit;
        font-size: 10px;
        font-weight: 650;
      }

      .selection-surface { position: fixed; inset: 0; cursor: crosshair; }
      .selection-box {
        position: fixed;
        border: 1.5px solid #8b9cff;
        border-radius: 5px;
        background: rgb(113 132 255 / 10%);
        box-shadow: 0 0 0 9999px rgb(8 10 18 / 18%), 0 0 0 1px rgb(255 255 255 / 18%) inset;
        pointer-events: none;
      }
      .selection-label {
        position: absolute;
        top: -27px;
        left: -1px;
        padding: 5px 7px;
        border-radius: 5px;
        color: #f7f8ff;
        background: #5668e8;
        font-size: 10px;
        font-weight: 650;
        white-space: nowrap;
      }
      .selection-tip {
        position: fixed;
        top: 18px;
        left: 50%;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px 8px 13px;
        transform: translateX(-50%);
        border: 1px solid rgb(255 255 255 / 13%);
        border-radius: 999px;
        color: #f8f8fa;
        background: rgb(18 19 24 / 92%);
        box-shadow: 0 12px 40px rgb(0 0 0 / 24%);
        font-size: 12px;
        backdrop-filter: blur(16px);
      }
      .selection-tip span { color: #a8a8b1; }

      .prompt-panel {
        position: fixed;
        left: 50%;
        bottom: 22px;
        width: min(540px, calc(100vw - 32px));
        padding: 10px;
        transform: translateX(-50%);
        border: 1px solid rgb(255 255 255 / 13%);
        border-radius: 17px;
        color: #f5f5f7;
        background: rgb(20 20 23 / 96%);
        box-shadow: 0 24px 90px rgb(0 0 0 / 38%);
        backdrop-filter: blur(22px);
      }
      .context-row { display: flex; align-items: center; gap: 10px; padding: 0 2px 9px; }
      .capture-preview {
        width: 72px;
        height: 48px;
        flex: 0 0 auto;
        border: 1px solid rgb(255 255 255 / 10%);
        border-radius: 8px;
        object-fit: cover;
        background: #2a2a2e;
      }
      .context-copy { display: grid; min-width: 0; gap: 3px; }
      .context-copy strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      .context-copy span { color: #92929c; font-size: 10px; }
      .close-button {
        width: 28px;
        height: 28px;
        margin-left: auto;
        border: 0;
        border-radius: 50%;
        color: #aaaab2;
        background: transparent;
      }
      .close-button:hover { color: #fff; background: rgb(255 255 255 / 8%); }
      textarea {
        display: block;
        width: 100%;
        min-height: 84px;
        padding: 14px 14px 10px;
        resize: none;
        border: 1px solid rgb(255 255 255 / 9%);
        border-radius: 11px;
        outline: none;
        color: #fff;
        background: #29292e;
        font-size: 14px;
        line-height: 1.45;
      }
      textarea::placeholder { color: #777781; }
      textarea:focus { border-color: rgb(126 143 255 / 72%); box-shadow: 0 0 0 3px rgb(99 119 255 / 12%); }
      .prompt-actions { display: flex; align-items: center; gap: 8px; padding: 9px 2px 0; }
      .prompt-actions span { color: #777781; font-size: 10px; }
      .apply-button {
        margin-left: auto;
        padding: 8px 12px;
        border: 0;
        border-radius: 9px;
        color: #fff;
        background: #6376f4;
        font-size: 11px;
        font-weight: 700;
      }
      .apply-button:hover { background: #7183f9; }
      .apply-button:disabled { cursor: wait; opacity: .58; }
      .spinner {
        display: inline-block;
        width: 10px;
        height: 10px;
        margin-right: 6px;
        border: 1.5px solid rgb(255 255 255 / 35%);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin .7s linear infinite;
      }
      .error { padding: 7px 4px 0; color: #ff9292; font-size: 11px; }
      .activity { margin-top: 9px; padding: 10px 12px; border: 1px solid rgb(255 255 255 / 8%); border-radius: 11px; background: #25252a; }
      .activity-header { display: flex; justify-content: space-between; margin-bottom: 8px; color: #b9b9c1; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
      .activity-header time { color: #777781; font-variant-numeric: tabular-nums; }
      .activity-list { display: grid; gap: 7px; max-height: 132px; overflow: auto; }
      .activity-item { display: grid; grid-template-columns: 12px 1fr; gap: 7px; color: #d2d2d8; font-size: 11px; line-height: 1.3; }
      .activity-dot { width: 7px; height: 7px; margin-top: 3px; border-radius: 50%; background: #6e7ff1; box-shadow: 0 0 0 3px rgb(110 127 241 / 13%); }
      .activity-item:last-child .activity-dot { animation: pulse 1s ease-in-out infinite alternate; }
      .activity-detail { display: block; margin-top: 2px; color: #777781; font-size: 9px; }
      .result { padding: 10px 9px 6px; }
      .result-mark {
        display: grid;
        width: 30px;
        height: 30px;
        margin-bottom: 12px;
        border-radius: 50%;
        place-items: center;
        color: #172318;
        background: #aee5ae;
        font-weight: 800;
      }
      .result h2 { margin: 0 0 5px; font-size: 15px; }
      .result p { margin: 0 0 14px; color: #a4a4ad; font-size: 12px; line-height: 1.45; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes pulse { to { opacity: .35; } }
    </style>
  </head>
  <body>
    <div class="shortcut-pill" id="shortcut-pill" hidden><span>Quick edit</span><kbd>Hyper E</kbd></div>

    <div class="selection-surface" id="selection-surface" hidden>
      <div class="selection-tip" id="selection-tip">Drag around what you want to change <span>Esc to cancel</span></div>
      <div class="selection-box" id="selection-box" hidden>
        <div class="selection-label" id="selection-label"></div>
      </div>
    </div>

    <form class="prompt-panel" id="prompt-panel" hidden>
      <div class="context-row">
        <img class="capture-preview" id="capture-preview" alt="Selected region" hidden />
        <div class="context-copy">
          <strong id="context-title">Collecting context…</strong>
          <span id="context-meta">Inspecting elements and capturing region</span>
        </div>
        <button class="close-button" type="button" id="close-button" aria-label="Cancel">×</button>
      </div>
      <div id="prompt-content">
        <textarea id="instruction" placeholder="What should change in this region?" required></textarea>
        <div class="error" id="error" hidden></div>
        <section class="activity" id="activity" aria-live="polite" hidden>
          <div class="activity-header"><span>Agent activity</span><time id="activity-time">0.0s</time></div>
          <div class="activity-list" id="activity-list"></div>
        </section>
        <div class="prompt-actions">
          <span>Enter to apply · Shift Enter for a new line</span>
          <button class="apply-button" id="apply-button" type="submit">Make change ↗</button>
        </div>
      </div>
      <div class="result" id="result" hidden>
        <div class="result-mark">✓</div>
        <h2>Change applied</h2>
        <p id="result-summary"></p>
        <div class="prompt-actions">
          <span id="result-meta"></span>
          <button class="apply-button" id="done-button" type="button">Done</button>
        </div>
      </div>
    </form>

    <script type="module">
      const surface = document.querySelector("#selection-surface");
      const tip = document.querySelector("#selection-tip");
      const box = document.querySelector("#selection-box");
      const label = document.querySelector("#selection-label");
      const pill = document.querySelector("#shortcut-pill");
      const panel = document.querySelector("#prompt-panel");
      const preview = document.querySelector("#capture-preview");
      const title = document.querySelector("#context-title");
      const meta = document.querySelector("#context-meta");
      const instruction = document.querySelector("#instruction");
      const applyButton = document.querySelector("#apply-button");
      const errorBox = document.querySelector("#error");
      const promptContent = document.querySelector("#prompt-content");
      const activity = document.querySelector("#activity");
      const activityList = document.querySelector("#activity-list");
      const activityTime = document.querySelector("#activity-time");
      const result = document.querySelector("#result");
      let start;
      let region;
      let selecting = false;
      let activitySubscription;
      let activityTimer;

      function stopActivity() {
        activitySubscription?.unsubscribe?.();
        activitySubscription = undefined;
        clearInterval(activityTimer);
        activityTimer = undefined;
      }

      function addActivity(item) {
        const row = document.createElement("div");
        row.className = "activity-item";
        const dot = document.createElement("span");
        dot.className = "activity-dot";
        const copy = document.createElement("span");
        copy.textContent = item.message;
        if (item.detail) {
          const detail = document.createElement("small");
          detail.className = "activity-detail";
          detail.textContent = item.detail;
          copy.append(detail);
        }
        row.append(dot, copy);
        activityList.append(row);
        activityList.scrollTop = activityList.scrollHeight;
      }

      async function startActivity(requestId) {
        stopActivity();
        activity.hidden = false;
        activityList.replaceChildren();
        const started = performance.now();
        activityTime.textContent = "0.0s";
        activityTimer = setInterval(() => {
          activityTime.textContent = ((performance.now() - started) / 1000).toFixed(1) + "s";
        }, 100);
        addActivity({ message: "Sending selected region to agent" });
        try {
          const module = await import("./activity-client.js");
          activitySubscription = module.subscribeToIterationActivity(requestId, {
            onData: addActivity,
            onError(error) {
              addActivity({ message: error?.message ?? "Activity connection lost" });
            },
            onComplete() {},
          });
        } catch (error) {
          addActivity({ message: error?.message ?? "Could not connect activity feed" });
        }
      }

      function post(message) {
        window.parent.postMessage({ source: "hyos-ui-agent", ...message }, "*");
      }

      function setBox(next) {
        region = next;
        box.hidden = false;
        box.style.left = next.x + "px";
        box.style.top = next.y + "px";
        box.style.width = next.width + "px";
        box.style.height = next.height + "px";
        label.textContent = Math.round(next.width) + " × " + Math.round(next.height);
      }

      function close() {
        stopActivity();
        selecting = false;
        start = undefined;
        region = undefined;
        surface.hidden = true;
        surface.style.cursor = "crosshair";
        tip.hidden = false;
        box.hidden = true;
        panel.hidden = true;
        activity.hidden = true;
        pill.hidden = true;
        instruction.value = "";
        post({ type: "close-overlay" });
      }

      function startSelection() {
        selecting = true;
        start = undefined;
        region = undefined;
        panel.hidden = true;
        box.hidden = true;
        pill.hidden = true;
        surface.hidden = false;
        surface.style.cursor = "crosshair";
        tip.hidden = false;
        errorBox.hidden = true;
        result.hidden = true;
        activity.hidden = true;
        promptContent.hidden = false;
      }

      surface.addEventListener("pointerdown", (event) => {
        if (!selecting || event.button !== 0) return;
        start = { x: event.clientX, y: event.clientY };
        surface.setPointerCapture(event.pointerId);
        setBox({ x: start.x, y: start.y, width: 1, height: 1 });
      });

      surface.addEventListener("pointermove", (event) => {
        if (!start) return;
        setBox({
          x: Math.min(start.x, event.clientX),
          y: Math.min(start.y, event.clientY),
          width: Math.abs(event.clientX - start.x),
          height: Math.abs(event.clientY - start.y),
        });
      });

      surface.addEventListener("pointerup", (event) => {
        if (!start || !region) return;
        surface.releasePointerCapture(event.pointerId);
        start = undefined;
        if (region.width < 8 || region.height < 8) return;
        selecting = false;
        surface.style.cursor = "default";
        tip.hidden = true;
        panel.hidden = false;
        preview.hidden = true;
        title.textContent = "Collecting context…";
        meta.textContent = "Inspecting elements and capturing region";
        instruction.disabled = true;
        applyButton.disabled = true;
        post({ type: "region-selected", region });
      });

      panel.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = instruction.value.trim();
        if (!value || instruction.disabled) return;
        instruction.disabled = true;
        applyButton.disabled = true;
        applyButton.innerHTML = '<span class="spinner"></span>Applying';
        errorBox.hidden = true;
        const requestId = crypto.randomUUID();
        void startActivity(requestId);
        post({ type: "submit-iteration", instruction: value, requestId });
      });

      instruction.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          panel.requestSubmit();
        }
      });

      document.querySelector("#close-button").addEventListener("click", close);
      document.querySelector("#done-button").addEventListener("click", close);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !pill.hidden) return;
        if (event.key === "Escape") close();
      });

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent || event.data?.source !== "hyos-ui-agent-host") return;
        if (event.data.type === "start-region-selection") {
          startSelection();
          return;
        }
        if (event.data.type === "cancel-overlay") {
          close();
          return;
        }
        if (event.data.type === "selection-context-ready") {
          const elements = event.data.elements ?? [];
          const sources = new Set(elements.map((item) => item.sourceHint).filter(Boolean));
          title.textContent = elements.length
            ? elements[0].text || elements[0].cssPath || "Selected region"
            : "Selected region";
          meta.textContent =
            elements.length + " DOM elements · " + sources.size + " source locations" +
            (event.data.captureError ? " · screenshot unavailable" : " · screenshot ready");
          if (event.data.screenshot?.dataUrl) {
            preview.src = event.data.screenshot.dataUrl;
            preview.hidden = false;
          }
          instruction.disabled = false;
          applyButton.disabled = false;
          instruction.focus();
          return;
        }
        if (event.data.type === "iteration-complete") {
          stopActivity();
          promptContent.hidden = true;
          result.hidden = false;
          document.querySelector("#result-summary").textContent =
            event.data.result?.summary ?? "The selected UI was updated.";
          const count = event.data.result?.edits?.length ?? 0;
          document.querySelector("#result-meta").textContent =
            count + (count === 1 ? " file edit" : " file edits");
          return;
        }
        if (event.data.type === "iteration-error") {
          stopActivity();
          instruction.disabled = false;
          applyButton.disabled = false;
          applyButton.textContent = "Try again ↗";
          errorBox.textContent = event.data.message;
          errorBox.hidden = false;
        }
      });

      post({ type: "overlay-ready" });
    </script>
  </body>
</html>`;
}
