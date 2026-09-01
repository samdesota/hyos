import { micromark } from "micromark";

export function renderAgentMarkdown(markdown: string): string {
  return micromark(markdown);
}

export function mermaidDefinition(
  language: string | undefined,
  source: string,
): string | undefined {
  if (language?.toLowerCase() === "mermaid") return source.trim();
  if (language?.toLowerCase() !== "text") return undefined;

  const wrapped =
    /^(\`{3,}|~{3,})[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/.exec(
      source.trim(),
    );
  return wrapped?.[2]?.trim();
}

export function mermaidZoomScale(scale: number, deltaY: number): number {
  return Math.min(5, Math.max(0.25, scale * Math.exp(-deltaY * 0.01)));
}

let mermaidPromise: Promise<(typeof import("mermaid"))["default"]> | undefined;
let diagramSequence = 0;

async function configuredMermaid() {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
    });
    return mermaid;
  });
  return mermaidPromise;
}

function showMermaidError(container: HTMLElement, source: string): void {
  const message = document.createElement("p");
  message.textContent = "Mermaid couldn't render this diagram.";
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  pre.append(code);
  container.classList.remove("rendering");
  container.classList.add("error");
  container.replaceChildren(message, pre);
}

function openMermaidViewer(
  svg: SVGElement,
  diagram: HTMLElement,
  opener: HTMLButtonElement,
): () => void {
  const overlay = document.createElement("div");
  overlay.className = "mermaid-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Mermaid diagram viewer");

  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-viewer-toolbar";
  const hint = document.createElement("span");
  hint.className = "mermaid-viewer-hint";
  hint.textContent = "Two-finger drag to pan · Pinch to zoom";

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset";
  reset.setAttribute("aria-label", "Reset diagram view");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "mermaid-viewer-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close diagram viewer");
  toolbar.append(hint, reset, close);

  const stage = document.createElement("div");
  stage.className = "mermaid-viewer-stage";
  const canvas = document.createElement("div");
  canvas.className = "mermaid-viewer-canvas";
  canvas.append(svg);
  stage.append(canvas);
  overlay.append(toolbar, stage);
  document.body.append(overlay);

  let x = 0;
  let y = 0;
  let scale = 1;
  let closed = false;
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const updateTransform = () => {
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  const resetView = () => {
    x = 0;
    y = 0;
    scale = 1;
    updateTransform();
  };
  const handleWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      scale = mermaidZoomScale(scale, event.deltaY);
    } else {
      x -= event.deltaX;
      y -= event.deltaY;
    }
    updateTransform();
  };
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeViewer();
  };
  const closeViewer = () => {
    if (closed) return;
    closed = true;
    stage.removeEventListener("wheel", handleWheel);
    document.removeEventListener("keydown", handleKeydown);
    diagram.insertBefore(svg, opener);
    overlay.remove();
    document.body.style.overflow = previousOverflow;
    opener.focus();
  };

  stage.addEventListener("wheel", handleWheel, { passive: false });
  document.addEventListener("keydown", handleKeydown);
  reset.addEventListener("click", resetView);
  close.addEventListener("click", closeViewer);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeViewer();
  });
  close.focus();
  return closeViewer;
}

function addMermaidViewer(
  container: HTMLElement,
  closeActiveViewer: () => void,
): () => void {
  const svg = container.querySelector("svg");
  if (!svg) return closeActiveViewer;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mermaid-fullscreen-button";
  button.textContent = "⛶";
  button.setAttribute("aria-label", "View diagram full screen");
  button.setAttribute("title", "View full screen");
  container.append(button);

  let closeViewer = closeActiveViewer;
  button.addEventListener("click", () => {
    closeViewer();
    closeViewer = openMermaidViewer(svg, container, button);
  });
  return () => closeViewer();
}

export function mountMarkdown(
  element: HTMLElement,
  markdown: string,
): () => void {
  let cancelled = false;
  let closeViewer = () => {};
  element.innerHTML = renderAgentMarkdown(markdown);
  const diagrams = [...element.querySelectorAll("pre > code")]
    .map((code) => {
      const pre = code.parentElement;
      if (!pre) return undefined;
      const language = [...code.classList]
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length);
      const source = mermaidDefinition(language, code.textContent ?? "");
      if (source === undefined) return undefined;
      const container = document.createElement("div");
      container.className = "mermaid-diagram rendering";
      container.setAttribute("aria-label", "Mermaid diagram");
      container.textContent = "Rendering diagram…";
      pre.replaceWith(container);
      return { container, source };
    })
    .filter((diagram): diagram is NonNullable<typeof diagram> => !!diagram);

  if (diagrams.length > 0) {
    void configuredMermaid()
      .then(async (mermaid) => {
        for (const { container, source } of diagrams) {
          if (cancelled) return;
          try {
            const parsed = await mermaid.parse(source, {
              suppressErrors: true,
            });
            if (!parsed) {
              showMermaidError(container, source);
              continue;
            }
            const id = `hyagent-mermaid-${++diagramSequence}`;
            const { svg, bindFunctions } = await mermaid.render(id, source);
            if (cancelled || !container.isConnected) return;
            container.classList.remove("rendering");
            container.innerHTML = svg;
            bindFunctions?.(container);
            closeViewer = addMermaidViewer(container, closeViewer);
          } catch {
            if (!cancelled && container.isConnected) {
              showMermaidError(container, source);
            }
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        for (const { container, source } of diagrams) {
          if (container.isConnected) showMermaidError(container, source);
        }
      });
  }

  return () => {
    cancelled = true;
    closeViewer();
  };
}
