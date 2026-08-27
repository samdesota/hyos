import "./styles.css";

// PROTOTYPE: Three host-page variants for testing the UI-agent overlay,
// switchable via ?variant=. This directory is intentionally throwaway.

const variants = [
  { key: "A", name: "Analytics dashboard" },
  { key: "B", name: "Project board" },
  { key: "C", name: "Storefront" },
] as const;

type VariantKey = (typeof variants)[number]["key"];

function shell(content: string): string {
  return `
    <div class="prototype-notice">
      <span>Prototype sandbox</span>
      <strong>UI Agent playground</strong>
      <span>The overlay is injected by the Vite plugin</span>
    </div>
    ${content}
  `;
}

function dashboard(): string {
  return shell(`
    <main class="dashboard-shell">
      <aside class="dashboard-sidebar">
        <div class="brand-mark">N</div>
        <nav aria-label="Dashboard navigation">
          <a class="nav-item active" href="#"><span>Overview</span><kbd>1</kbd></a>
          <a class="nav-item" href="#"><span>Customers</span><span>2.4k</span></a>
          <a class="nav-item" href="#"><span>Activity</span><span>18</span></a>
          <a class="nav-item" href="#"><span>Reports</span><span>↗</span></a>
        </nav>
        <div class="sidebar-profile">
          <div class="avatar">AM</div>
          <div><strong>Alex Morgan</strong><span>alex@example.com</span></div>
        </div>
      </aside>

      <section class="dashboard-content">
        <header class="page-heading">
          <div><span class="eyebrow">Workspace overview</span><h1>Good morning, Alex.</h1></div>
          <div class="heading-actions"><button class="button ghost">Export</button><button class="button dark">Create report</button></div>
        </header>

        <div class="metric-grid">
          <article class="metric-card accent"><span>Monthly revenue</span><strong>$84,280</strong><small>↑ 12.4% from last month</small></article>
          <article class="metric-card"><span>Active customers</span><strong>2,420</strong><small>196 joined this month</small></article>
          <article class="metric-card"><span>Conversion</span><strong>8.42%</strong><small>Target is 9.00%</small></article>
        </div>

        <div class="dashboard-grid">
          <article class="panel chart-panel">
            <div class="panel-heading"><div><span class="eyebrow">Performance</span><h2>Revenue trend</h2></div><button class="icon-button">•••</button></div>
            <div class="chart" aria-label="Decorative revenue chart">
              <div style="height:32%"></div><div style="height:46%"></div><div style="height:38%"></div><div style="height:65%"></div><div style="height:57%"></div><div style="height:82%"></div><div style="height:73%"></div><div style="height:94%"></div>
            </div>
            <div class="chart-labels"><span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span><span>Jul</span><span>Aug</span></div>
          </article>
          <article class="panel activity-panel">
            <div class="panel-heading"><div><span class="eyebrow">Live</span><h2>Recent activity</h2></div><span class="status-dot">6 new</span></div>
            <ul class="activity-list">
              <li><span class="activity-icon blue">↗</span><div><strong>Enterprise plan upgraded</strong><small>Northstar Labs · 4m ago</small></div><b>+$480</b></li>
              <li><span class="activity-icon coral">+</span><div><strong>New customer joined</strong><small>Clearwater Studio · 18m ago</small></div><b>+$120</b></li>
              <li><span class="activity-icon green">✓</span><div><strong>Invoice paid</strong><small>Sequence Systems · 41m ago</small></div><b>+$890</b></li>
            </ul>
          </article>
        </div>
      </section>
    </main>
  `);
}

function projectBoard(): string {
  return shell(`
    <main class="board-shell">
      <header class="board-header">
        <div class="board-brand"><div class="board-logo">T</div><strong>Thread</strong></div>
        <label class="search"><span>⌕</span><input placeholder="Search anything" /></label>
        <div class="board-actions"><button class="round-button">?</button><div class="avatar lavender">KS</div></div>
      </header>

      <section class="board-content">
        <div class="board-title-row">
          <div><span class="crumb">Projects / Website refresh</span><h1>Website refresh</h1><p>Coordinate the final design and launch work.</p></div>
          <div class="collaborators"><span>AM</span><span>JV</span><span>KS</span><button>+ Invite</button></div>
        </div>
        <div class="board-toolbar">
          <div class="view-tabs"><button class="active">Board</button><button>List</button><button>Timeline</button></div>
          <div><button class="filter-button">≡ Filter</button><button class="new-task">+ New task</button></div>
        </div>

        <div class="kanban">
          <section class="kanban-column">
            <header><span><i class="dot slate"></i>Backlog</span><b>3</b></header>
            <article class="task-card"><span class="tag research">Research</span><h3>Audit the current navigation patterns</h3><p>Document usability problems across the primary flows.</p><footer><span class="avatar tiny">AM</span><span>◷ Tomorrow</span></footer></article>
            <article class="task-card"><span class="tag content">Content</span><h3>Rewrite the pricing page</h3><p>Clarify differences between plans and remove jargon.</p><footer><span class="avatar tiny peach">JV</span><span>◷ Friday</span></footer></article>
            <button class="add-card">+ Add a task</button>
          </section>
          <section class="kanban-column">
            <header><span><i class="dot blue"></i>In progress</span><b>2</b></header>
            <article class="task-card featured"><span class="tag design">Design</span><h3>Build the new component inventory</h3><p>Map components to product surfaces before cleanup.</p><div class="progress"><span style="width:68%"></span></div><footer><span class="avatar tiny lavender">KS</span><span>3 / 5</span></footer></article>
            <article class="task-card"><span class="tag engineering">Engineering</span><h3>Improve mobile menu transitions</h3><p>Prototype a faster and less distracting interaction.</p><footer><span class="avatar tiny">AM</span><span>◷ Today</span></footer></article>
            <button class="add-card">+ Add a task</button>
          </section>
          <section class="kanban-column">
            <header><span><i class="dot green"></i>Complete</span><b>2</b></header>
            <article class="task-card done"><span class="tag design">Design</span><h3>Agree on the visual direction</h3><p>Warm neutrals, editorial typography, restrained motion.</p><footer><span class="avatar tiny peach">JV</span><span>✓ Done</span></footer></article>
            <article class="task-card done"><span class="tag research">Research</span><h3>Interview customer success</h3><p>Capture the top ten points of confusion.</p><footer><span class="avatar tiny lavender">KS</span><span>✓ Done</span></footer></article>
            <button class="add-card">+ Add a task</button>
          </section>
        </div>
      </section>
    </main>
  `);
}

function storefront(): string {
  return shell(`
    <main class="store-shell">
      <nav class="store-nav">
        <a class="store-logo" href="#">FIELD / NOTE</a>
        <div><a href="#">Objects</a><a href="#">Journal</a><a href="#">About</a></div>
        <button class="bag-button">Bag <span>2</span></button>
      </nav>

      <section class="store-hero">
        <div class="hero-copy">
          <span class="collection-label">Edition No. 04 · Autumn 2026</span>
          <h1>Objects for<br />considered days.</h1>
          <p>Useful pieces made slowly, chosen for texture, proportion, and the quiet pleasure of daily use.</p>
          <a class="shop-link" href="#products">Explore the collection <span>→</span></a>
        </div>
        <div class="hero-art">
          <div class="sun"></div><div class="vase"><span></span><i></i><b></b></div><div class="table-line"></div>
          <span class="art-caption">Hand-thrown vessel<br />Stoneware · Ash glaze</span>
        </div>
      </section>

      <section class="product-section" id="products">
        <div class="section-heading"><div><span class="collection-label">The everyday edit</span><h2>Made to be used.</h2></div><p>A small collection of tactile essentials for the desk, table, and spaces between.</p></div>
        <div class="product-grid">
          <article class="product"><div class="product-art lamp"><span></span></div><div class="product-info"><div><h3>Fold lamp</h3><span>Powder-coated steel</span></div><strong>$180</strong></div></article>
          <article class="product offset"><div class="product-art tray"><span></span><i></i></div><div class="product-info"><div><h3>Arc tray</h3><span>Solid oak</span></div><strong>$74</strong></div></article>
          <article class="product"><div class="product-art cup"><span></span></div><div class="product-info"><div><h3>Daily cup</h3><span>Glazed stoneware</span></div><strong>$42</strong></div></article>
        </div>
      </section>
    </main>
  `);
}

const renderers: Record<VariantKey, () => string> = {
  A: dashboard,
  B: projectBoard,
  C: storefront,
};

function currentVariant(): VariantKey {
  const value = new URLSearchParams(location.search).get("variant");
  return variants.some((variant) => variant.key === value)
    ? (value as VariantKey)
    : "A";
}

function setVariant(key: VariantKey): void {
  const url = new URL(location.href);
  url.searchParams.set("variant", key);
  history.replaceState(null, "", url);
  render();
}

function cycle(direction: -1 | 1): void {
  const index = variants.findIndex((item) => item.key === currentVariant());
  const next = (index + direction + variants.length) % variants.length;
  setVariant(variants[next].key);
}

function render(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) return;

  const key = currentVariant();
  const variant = variants.find((item) => item.key === key) ?? variants[0];
  app.innerHTML = `
    ${renderers[key]()}
    <div class="prototype-switcher" aria-label="Prototype variant switcher">
      <button data-direction="previous" aria-label="Previous variant">←</button>
      <span><b>${variant.key}</b> ${variant.name}</span>
      <button data-direction="next" aria-label="Next variant">→</button>
    </div>
  `;

  app
    .querySelector('[data-direction="previous"]')
    ?.addEventListener("click", () => cycle(-1));
  app
    .querySelector('[data-direction="next"]')
    ?.addEventListener("click", () => cycle(1));
}

window.addEventListener("popstate", render);
window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, [contenteditable]")) return;
  if (event.key === "ArrowLeft") cycle(-1);
  if (event.key === "ArrowRight") cycle(1);
});

render();
