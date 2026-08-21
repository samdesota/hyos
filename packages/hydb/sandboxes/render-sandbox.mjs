const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const serializeForScript = (value) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

export function renderSandbox(manifest) {
  const data = serializeForScript(manifest);
  return `<!doctype html>
<!-- Generated sandbox artifact. Edit its generator, not this file. -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(manifest.title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --canvas: #0a0b0d;
        --panel: #121419;
        --panel-raised: #181b22;
        --line: #2a2e37;
        --muted: #9299a8;
        --text: #f2f4f7;
        --accent: #9cf5c7;
        --accent-dim: #17372a;
        --warning: #f6c177;
      }

      * { box-sizing: border-box; }
      [hidden] { display: none !important; }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at 78% -10%, #163028 0, transparent 32rem),
          var(--canvas);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      button { font: inherit; }

      .shell {
        width: min(1500px, 100%);
        margin: 0 auto;
        padding: 34px clamp(18px, 4vw, 58px) 48px;
      }

      .eyebrow {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        color: var(--accent);
        font-size: 12px;
        font-weight: 750;
        letter-spacing: .14em;
        text-transform: uppercase;
      }

      .eyebrow::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 18px var(--accent);
      }

      h1 {
        max-width: 780px;
        margin: 18px 0 10px;
        font-size: clamp(34px, 5vw, 64px);
        line-height: .98;
        letter-spacing: -.045em;
      }

      .question {
        max-width: 780px;
        margin: 0;
        color: #bec4cf;
        font-size: clamp(16px, 2vw, 20px);
        line-height: 1.55;
      }

      .workspace {
        margin-top: 14px;
      }

      .panel {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: color-mix(in srgb, var(--panel) 94%, transparent);
        box-shadow: 0 24px 80px rgb(0 0 0 / 24%);
      }

      .scenario-tabs {
        margin-top: 34px;
        padding: 7px;
        overflow-x: auto;
      }

      #scenario-list {
        display: flex;
        gap: 5px;
        min-width: max-content;
      }

      .scenario {
        min-width: 142px;
        padding: 11px 14px;
        border: 1px solid transparent;
        border-radius: 10px;
        background: transparent;
        color: #c5cad3;
        text-align: center;
        cursor: pointer;
      }

      .scenario:hover { background: var(--panel-raised); }
      .scenario.active {
        border-color: #315e4a;
        background: var(--accent-dim);
        color: var(--text);
      }

      .scenario strong { display: block; font-size: 13px; white-space: nowrap; }
      .scenario span { display: none; }

      .viewer { min-width: 0; overflow: hidden; }

      .viewer-header {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        padding: 22px 24px;
        border-bottom: 1px solid var(--line);
      }

      .viewer-header h2 { margin: 0; font-size: 21px; letter-spacing: -.02em; }
      .viewer-header p { max-width: 720px; margin: 7px 0 0; color: var(--muted); font-size: 14px; line-height: 1.45; }

      .access-badge {
        flex: none;
        align-self: start;
        padding: 7px 10px;
        border: 1px solid #315e4a;
        border-radius: 999px;
        background: var(--accent-dim);
        color: var(--accent);
        font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        text-transform: uppercase;
      }

      .pipeline {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        padding: 18px 24px;
        border-bottom: 1px solid var(--line);
      }

      .stage-button {
        position: relative;
        min-width: 0;
        padding: 11px 12px;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: var(--muted);
        text-align: left;
        cursor: pointer;
      }

      .stage-button:not(:last-child)::after {
        content: "→";
        position: absolute;
        top: 14px;
        right: -5px;
        color: #4f5561;
      }

      .stage-button.active { background: var(--panel-raised); color: var(--text); }
      .stage-number { display: block; margin-bottom: 5px; color: var(--accent); font: 700 11px/1 ui-monospace, monospace; }
      .stage-name { display: block; overflow: hidden; font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }

      .stage-content { padding: 24px; }

      .stage-copy {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        align-items: end;
        margin-bottom: 14px;
      }

      .stage-copy h3 { margin: 0 0 7px; font-size: 18px; }
      .stage-copy p { max-width: 720px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
      .language { color: var(--warning); font: 700 11px/1 ui-monospace, monospace; text-transform: uppercase; }

      pre {
        min-height: 430px;
        max-height: 62vh;
        margin: 0;
        padding: 20px;
        overflow: auto;
        border: 1px solid #252a33;
        border-radius: 13px;
        background: #0d0f13;
        color: #d9dee7;
        font: 13px/1.62 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        tab-size: 2;
        white-space: pre;
      }

      .graph-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(250px, 330px);
        min-height: 500px;
        overflow: hidden;
        border: 1px solid #252a33;
        border-radius: 13px;
        background: #0d0f13;
      }

      .graph-canvas {
        min-width: 0;
        padding: 30px 24px 48px;
        overflow: auto;
        background:
          linear-gradient(rgb(255 255 255 / 2%) 1px, transparent 1px),
          linear-gradient(90deg, rgb(255 255 255 / 2%) 1px, transparent 1px);
        background-size: 24px 24px;
      }

      .graph-legend {
        display: flex;
        gap: 14px;
        align-items: center;
        margin-bottom: 24px;
        color: var(--muted);
        font: 700 10px/1 ui-monospace, monospace;
        text-transform: uppercase;
      }

      .graph-legend strong { color: var(--accent); }
      .legend-line { display: inline-block; width: 22px; border-top: 1px solid #687281; }
      .legend-line.dependency { border-top-style: dashed; border-color: var(--warning); }

      .graph-tree {
        display: flex;
        justify-content: center;
        min-width: max-content;
      }

      .graph-subtree {
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .graph-node {
        position: relative;
        z-index: 1;
        width: 190px;
        padding: 12px 13px;
        border: 1px solid #343a45;
        border-radius: 11px;
        background: #171a20;
        color: var(--text);
        text-align: left;
        cursor: pointer;
        box-shadow: 0 8px 28px rgb(0 0 0 / 22%);
      }

      .graph-node:hover { border-color: #557363; }
      .graph-node.active {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px rgb(156 245 199 / 12%), 0 8px 28px rgb(0 0 0 / 28%);
      }

      .graph-node-kind {
        display: block;
        margin-bottom: 6px;
        color: var(--accent);
        font: 700 10px/1 ui-monospace, monospace;
        letter-spacing: .08em;
        text-transform: uppercase;
      }

      .graph-node-label { display: block; font-size: 13px; font-weight: 750; }
      .graph-node-summary { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.35; }

      .graph-children {
        position: relative;
        display: flex;
        justify-content: center;
        gap: 28px;
        padding-bottom: 31px;
      }

      .graph-children::after {
        content: "";
        position: absolute;
        bottom: 0;
        left: 50%;
        width: 1px;
        height: 18px;
        background: #4d5562;
      }

      .graph-child {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding-bottom: 19px;
      }

      .graph-child::after {
        content: "";
        position: absolute;
        bottom: 0;
        left: 50%;
        width: 1px;
        height: 19px;
        background: #4d5562;
      }

      .graph-child.dependency::after {
        width: 0;
        border-left: 1px dashed var(--warning);
        background: transparent;
      }

      .graph-edge-label {
        position: absolute;
        z-index: 2;
        bottom: -14px;
        left: 50%;
        padding: 3px 7px;
        border: 1px solid #343a45;
        border-radius: 999px;
        background: #101217;
        color: #aeb5c1;
        font: 700 9px/1 ui-monospace, monospace;
        transform: translateX(-50%);
        white-space: nowrap;
      }

      .node-detail {
        padding: 22px;
        overflow: auto;
        border-left: 1px solid var(--line);
        background: #12151a;
      }

      .node-detail-kind {
        color: var(--accent);
        font: 700 10px/1 ui-monospace, monospace;
        letter-spacing: .1em;
        text-transform: uppercase;
      }

      .node-detail h4 { margin: 10px 0 7px; font-size: 19px; }
      .node-detail p { margin: 0 0 16px; color: var(--muted); font-size: 12px; line-height: 1.5; }
      .node-detail pre {
        min-height: 0;
        max-height: none;
        padding: 13px;
        font-size: 11px;
        line-height: 1.55;
        white-space: pre-wrap;
      }

      .decision {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 10px;
        margin-top: 14px;
        padding: 13px 15px;
        border: 1px solid #263b31;
        border-radius: 11px;
        background: #101914;
        color: #cad3cd;
        font-size: 13px;
        line-height: 1.45;
      }

      .decision strong { color: var(--accent); }

      .controls {
        display: flex;
        justify-content: space-between;
        padding: 0 24px 24px;
      }

      .controls button {
        padding: 9px 13px;
        border: 1px solid var(--line);
        border-radius: 9px;
        background: var(--panel-raised);
        color: var(--text);
        cursor: pointer;
      }

      .controls button:disabled { opacity: .35; cursor: default; }

      @media (max-width: 800px) {
        .scenario-tabs { margin-top: 24px; }
        .scenario { min-width: 128px; }
        .viewer-header { align-items: start; flex-direction: column; }
        .pipeline { padding-inline: 12px; }
        .stage-content { padding: 18px 12px; }
        .stage-copy { align-items: start; flex-direction: column; gap: 8px; }
        .controls { padding-inline: 12px; }
        pre { min-height: 360px; font-size: 12px; }
        .graph-layout { grid-template-columns: 1fr; }
        .node-detail { border-top: 1px solid var(--line); border-left: 0; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="eyebrow">Interpretability prototype · generated from real HyDB code</div>
      <h1>${escapeHtml(manifest.title)}</h1>
      <p class="question">${escapeHtml(manifest.question)}</p>
      <nav class="panel scenario-tabs" aria-label="Query examples">
        <div id="scenario-list" role="tablist"></div>
      </nav>
      <div class="workspace">
        <section class="panel viewer" aria-live="polite">
          <header class="viewer-header">
            <div><h2 id="scenario-title"></h2><p id="scenario-description"></p></div>
            <div class="access-badge" id="access-badge"></div>
          </header>
          <div class="pipeline" id="pipeline"></div>
          <div class="stage-content">
            <div class="stage-copy">
              <div><h3 id="stage-title"></h3><p id="stage-description"></p></div>
              <div class="language" id="stage-language"></div>
            </div>
            <div id="code-view"><pre><code id="stage-code"></code></pre></div>
            <div class="graph-layout" id="graph-view" hidden>
              <div class="graph-canvas">
                <div class="graph-legend">
                  <strong>Execution ↓</strong>
                  <span class="legend-line"></span><span>row flow</span>
                  <span class="legend-line dependency"></span><span>parameter dependency</span>
                </div>
                <div class="graph-tree" id="graph-tree"></div>
              </div>
              <aside class="node-detail">
                <div class="node-detail-kind" id="node-detail-kind"></div>
                <h4 id="node-detail-title"></h4>
                <p id="node-detail-summary"></p>
                <pre><code id="node-detail-json"></code></pre>
              </aside>
            </div>
            <div class="decision"><strong>What changed</strong><span id="decision-copy"></span></div>
          </div>
          <div class="controls">
            <button id="previous-stage" type="button">← Previous stage</button>
            <button id="next-stage" type="button">Next stage →</button>
          </div>
        </section>
      </div>
    </main>
    <script>
      const manifest = ${data};
      let scenarioIndex = 0;
      let stageIndex = 0;
      let selectedNodeId;

      const byId = (id) => document.getElementById(id);
      const scenarioList = byId("scenario-list");
      const pipeline = byId("pipeline");

      function showNodeDetails(node) {
        byId("node-detail-kind").textContent = node.kind;
        byId("node-detail-title").textContent = node.label;
        byId("node-detail-summary").textContent = node.summary;
        byId("node-detail-json").textContent = JSON.stringify(node.details, null, 2);
      }

      function renderGraph(graph) {
        const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
        if (!nodes.has(selectedNodeId)) selectedNodeId = graph.root;

        function renderNode(nodeId) {
          const node = nodes.get(nodeId);
          const subtree = document.createElement("div");
          subtree.className = "graph-subtree";

          const button = document.createElement("button");
          button.type = "button";
          button.className = "graph-node" + (node.id === selectedNodeId ? " active" : "");
          const kind = document.createElement("span");
          kind.className = "graph-node-kind";
          kind.textContent = node.kind;
          const label = document.createElement("span");
          label.className = "graph-node-label";
          label.textContent = node.label;
          const summary = document.createElement("span");
          summary.className = "graph-node-summary";
          summary.textContent = node.summary;
          button.append(kind, label, summary);
          button.addEventListener("click", () => {
            selectedNodeId = node.id;
            renderGraph(graph);
          });
          if (node.children.length > 0) {
            const children = document.createElement("div");
            children.className = "graph-children";
            for (const child of node.children) {
              const branch = document.createElement("div");
              branch.className = "graph-child" + (child.kind === "dependency" ? " dependency" : "");
              const edge = document.createElement("span");
              edge.className = "graph-edge-label";
              edge.textContent = child.label;
              branch.append(renderNode(child.id), edge);
              children.append(branch);
            }
            subtree.append(children);
          }
          subtree.append(button);
          return subtree;
        }

        byId("graph-tree").replaceChildren(renderNode(graph.root));
        showNodeDetails(nodes.get(selectedNodeId));
      }

      function render() {
        const scenario = manifest.scenarios[scenarioIndex];
        const stage = scenario.stages[stageIndex];

        scenarioList.replaceChildren(...manifest.scenarios.map((item, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.role = "tab";
          button.setAttribute("aria-selected", String(index === scenarioIndex));
          button.className = "scenario" + (index === scenarioIndex ? " active" : "");
          const label = document.createElement("strong");
          label.textContent = item.label;
          const summary = document.createElement("span");
          summary.textContent = item.summary;
          button.append(label, summary);
          button.addEventListener("click", () => { scenarioIndex = index; stageIndex = 0; selectedNodeId = undefined; render(); });
          return button;
        }));

        pipeline.replaceChildren(...scenario.stages.map((item, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "stage-button" + (index === stageIndex ? " active" : "");
          const number = document.createElement("span");
          number.className = "stage-number";
          number.textContent = "0" + (index + 1);
          const name = document.createElement("span");
          name.className = "stage-name";
          name.textContent = item.label;
          button.append(number, name);
          button.addEventListener("click", () => { stageIndex = index; selectedNodeId = undefined; render(); });
          return button;
        }));

        byId("scenario-title").textContent = scenario.label;
        byId("scenario-description").textContent = scenario.description;
        byId("access-badge").textContent = scenario.access;
        byId("stage-title").textContent = stage.label;
        byId("stage-description").textContent = stage.description;
        byId("stage-language").textContent = stage.language;
        const graphStage = stage.view === "graph";
        byId("code-view").hidden = graphStage;
        byId("graph-view").hidden = !graphStage;
        if (graphStage) renderGraph(stage.graph);
        else byId("stage-code").textContent = stage.content;
        byId("decision-copy").textContent = stage.decision;
        byId("previous-stage").disabled = stageIndex === 0;
        byId("next-stage").disabled = stageIndex === scenario.stages.length - 1;
      }

      byId("previous-stage").addEventListener("click", () => { if (stageIndex > 0) { stageIndex -= 1; selectedNodeId = undefined; render(); } });
      byId("next-stage").addEventListener("click", () => {
        const scenario = manifest.scenarios[scenarioIndex];
        if (stageIndex < scenario.stages.length - 1) { stageIndex += 1; selectedNodeId = undefined; render(); }
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft") byId("previous-stage").click();
        if (event.key === "ArrowRight") byId("next-stage").click();
      });
      render();
    </script>
  </body>
</html>`;
}
