import { For, Match, Show, Switch as MatchSwitch, createSignal, onMount } from "solid-js";
import {
  ArrowRight,
  Blocks,
  Check,
  ChevronRight,
  CircleDollarSign,
  Component,
  Copy,
  LayoutDashboard,
  Menu,
  Moon,
  Palette,
  Plus,
  Search,
  Sparkles,
  Sun,
  WalletCards,
  X,
  Zap,
} from "lucide-solid";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  IconButton,
  Input,
  Progress,
  SegmentedControl,
  Switch,
  Textarea,
} from "./components";
import { AppShell, DashboardLayout, FeedLayout, FormLayout } from "./layouts";

type Section = "Components" | "Layouts" | "Tokens";
type Layout = "Dashboard" | "Feed" | "Form";
type Theme = "light" | "dark";

const sections: Array<{ name: Section; icon: typeof Component }> = [
  { name: "Components", icon: Component },
  { name: "Layouts", icon: LayoutDashboard },
  { name: "Tokens", icon: Palette },
];

const tokenGroups = [
  {
    title: "SURFACES",
    tokens: [
      ["Canvas", "--hy-canvas", "var(--hy-canvas)"],
      ["Surface", "--hy-surface", "var(--hy-surface)"],
      ["Raised", "--hy-raised", "var(--hy-raised)"],
      ["Ink", "--hy-ink", "var(--hy-ink)"],
    ],
  },
  {
    title: "SIGNALS",
    tokens: [
      ["Signal", "--hy-signal", "var(--hy-signal)"],
      ["Electric", "--hy-electric", "var(--hy-electric)"],
      ["Success", "--hy-success", "var(--hy-success)"],
      ["Danger", "--hy-danger", "var(--hy-danger)"],
    ],
  },
];

function ThemeToggle(props: { theme: Theme; onToggle: () => void }) {
  return (
    <IconButton
      aria-label={`Switch to ${props.theme === "light" ? "dark" : "light"} mode`}
      onClick={props.onToggle}
    >
      <Show when={props.theme === "light"} fallback={<Sun size={18} />}>
        <Moon size={18} />
      </Show>
    </IconButton>
  );
}

function SectionHeading(props: { eyebrow: string; title: string; copy: string }) {
  return (
    <header class="section-heading">
      <span class="eyebrow">{props.eyebrow}</span>
      <div class="section-heading__row">
        <div>
          <h1>{props.title}</h1>
          <p>{props.copy}</p>
        </div>
        <Badge tone="accent">V0.1</Badge>
      </div>
    </header>
  );
}

function ComponentsPage() {
  const [enabled, setEnabled] = createSignal(true);
  const [checked, setChecked] = createSignal(true);
  const [segment, setSegment] = createSignal<"Daily" | "Weekly" | "Monthly">("Weekly");

  return (
    <div class="page-stack">
      <SectionHeading
        eyebrow="01 / PRIMITIVES"
        title="Built to feel tangible."
        copy="Crisp edges, obvious states, and controls designed for thumbs before cursors."
      />

      <section class="specimen-grid">
        <Card class="specimen specimen--wide">
          <div class="specimen__head">
            <div>
              <span class="specimen__index">A.01</span>
              <h2>Actions</h2>
            </div>
            <span class="specimen__note">44PX MIN TOUCH TARGET</span>
          </div>
          <div class="specimen__body button-grid">
            <Button>
              Build app <Sparkles size={16} />
            </Button>
            <Button variant="secondary">
              Preview <ArrowRight size={16} />
            </Button>
            <Button variant="quiet">Cancel</Button>
            <Button variant="danger">Delete</Button>
            <Button disabled>Building…</Button>
            <IconButton aria-label="Add item">
              <Plus size={18} />
            </IconButton>
          </div>
        </Card>

        <Card class="specimen">
          <div class="specimen__head">
            <div>
              <span class="specimen__index">A.02</span>
              <h2>Inputs</h2>
            </div>
          </div>
          <div class="specimen__body field-stack">
            <Input label="APP NAME" placeholder="Daily brief" hint="Keep it short and useful." />
            <Input label="WEBHOOK URL" value="hyos://digest/daily" readOnly />
            <Textarea
              label="INSTRUCTIONS"
              placeholder="Summarize anything that needs my attention…"
              rows={3}
            />
          </div>
        </Card>

        <Card class="specimen">
          <div class="specimen__head">
            <div>
              <span class="specimen__index">A.03</span>
              <h2>Selection</h2>
            </div>
          </div>
          <div class="specimen__body selection-stack">
            <SegmentedControl
              label="Digest frequency"
              options={["Daily", "Weekly", "Monthly"] as const}
              value={segment()}
              onChange={setSegment}
            />
            <Switch
              label="Smart notifications"
              description="Only notify when action is needed."
              checked={enabled()}
              onChange={setEnabled}
            />
            <Checkbox label="Include newsletters" checked={checked()} onChange={setChecked} />
          </div>
        </Card>

        <Card class="specimen specimen--wide">
          <div class="specimen__head">
            <div>
              <span class="specimen__index">A.04</span>
              <h2>Status & feedback</h2>
            </div>
            <span class="specimen__note">NEVER COLOR ALONE</span>
          </div>
          <div class="specimen__body feedback-grid">
            <div class="badge-row">
              <Badge>Draft</Badge>
              <Badge tone="accent">Testing</Badge>
              <Badge tone="success">Live</Badge>
              <Badge tone="warning">Needs input</Badge>
            </div>
            <Progress value={72} label="Building your app" />
            <div class="inline-notice">
              <span class="inline-notice__icon"><Check size={16} /></span>
              <span><strong>12 checks passed.</strong> Your app is ready to use.</span>
              <IconButton aria-label="Dismiss"><X size={16} /></IconButton>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}

function DashboardExample() {
  return (
    <AppShell title="Pocket budget">
      <DashboardLayout
        header={
          <div class="mobile-greeting">
            <span class="micro-label">AUG 18 — AUG 24</span>
            <h3>Good morning, Sam.</h3>
          </div>
        }
        hero={
          <div class="balance-block">
            <span>SAFE TO SPEND</span>
            <strong>$842<span>.50</span></strong>
            <div class="balance-block__change">↑ 12% from last week</div>
          </div>
        }
        metrics={
          <div class="mobile-two-col">
            <div class="metric-tile">
              <WalletCards size={18} />
              <span>UPCOMING</span>
              <strong>$124.00</strong>
            </div>
            <div class="metric-tile metric-tile--signal">
              <Zap size={18} />
              <span>ON TRACK</span>
              <strong>4 days</strong>
            </div>
          </div>
        }
        sectionHeader={
          <div class="mobile-section-title">
            <strong>Recent activity</strong>
            <button>See all</button>
          </div>
        }
      >
        <For each={[["Corner market", "Groceries", "−$42.18"], ["Acme Studio", "Income", "+$850.00"], ["Metro", "Transport", "−$18.00"]]}>
          {(item) => (
            <div class="transaction-row">
              <span class="transaction-row__icon"><CircleDollarSign size={17} /></span>
              <span><strong>{item[0]}</strong><small>{item[1]}</small></span>
              <strong>{item[2]}</strong>
            </div>
          )}
        </For>
      </DashboardLayout>
    </AppShell>
  );
}

function FeedExample() {
  return (
    <AppShell title="Daily brief">
      <FeedLayout
        hero={
          <div class="digest-hero">
            <Badge tone="success">READY</Badge>
            <span class="micro-label">TUESDAY, AUGUST 18</span>
            <h3>Your inbox, distilled.</h3>
            <p>4 things need attention. Everything else can wait.</p>
          </div>
        }
        sectionHeader={
          <div class="mobile-section-title">
            <strong>Needs your attention</strong>
            <Badge tone="accent">4</Badge>
          </div>
        }
        action={<Button class="mobile-full-button">Review all <ArrowRight size={16} /></Button>}
      >
        <For each={[
          ["Reply to Maya", "Project estimate needs approval", "8m ago"],
          ["Review invoice", "Northeast Electric · $184.20", "1h ago"],
          ["Confirm dinner", "Reservation expires at 3:00 PM", "2h ago"],
        ]}>
          {(item, index) => (
            <button class="feed-row">
              <span class="feed-row__number">0{index() + 1}</span>
              <span><strong>{item[0]}</strong><small>{item[1]}</small><em>{item[2]}</em></span>
              <ChevronRight size={18} />
            </button>
          )}
        </For>
      </FeedLayout>
    </AppShell>
  );
}

function FormExample() {
  return (
    <AppShell title="Trip planner">
      <FormLayout
        intro={
          <div class="mobile-greeting">
            <span class="micro-label">NEW PLAN / 01</span>
            <h3>Where are you going?</h3>
            <p>Start with the basics. You can refine everything later.</p>
          </div>
        }
        action={<Button class="mobile-full-button">Create plan <Sparkles size={16} /></Button>}
      >
        <Input label="DESTINATION" placeholder="City or region" />
        <div class="mobile-two-col mobile-two-col--fields">
          <Input label="START" type="text" value="Sep 12" />
          <Input label="END" type="text" value="Sep 18" />
        </div>
        <label class="choice-block is-selected">
          <span class="choice-block__check"><Check size={15} /></span>
          <span><strong>Balanced</strong><small>A mix of plans and free time</small></span>
        </label>
        <label class="choice-block">
          <span class="choice-block__check" />
          <span><strong>Spontaneous</strong><small>Just the essentials</small></span>
        </label>
      </FormLayout>
    </AppShell>
  );
}

function LayoutsPage() {
  const [layout, setLayout] = createSignal<Layout>("Dashboard");
  return (
    <div class="page-stack">
      <SectionHeading
        eyebrow="02 / LAYOUTS"
        title="Mobile is the canvas."
        copy="Reusable app structures with hierarchy, navigation, and safe touch zones already solved."
      />
      <div class="layout-workbench">
        <aside class="layout-picker">
          <span class="micro-label">LAYOUT TYPE</span>
          <For each={(["Dashboard", "Feed", "Form"] as Layout[])}>
            {(item, index) => (
              <button classList={{ "is-active": layout() === item }} onClick={() => setLayout(item)}>
                <span>0{index() + 1}</span>
                <strong>{item}</strong>
                <ChevronRight size={17} />
              </button>
            )}
          </For>
          <div class="layout-rule">
            <Blocks size={18} />
            <p><strong>One primary action.</strong> Put it in the natural thumb zone and keep it persistent when needed.</p>
          </div>
        </aside>
        <div class="phone-stage">
          <div class="phone-stage__grid" />
          <div class="phone-stage__label">390 × 844 / MOBILE PRIMARY</div>
          <MatchSwitch>
            <Match when={layout() === "Dashboard"}><DashboardExample /></Match>
            <Match when={layout() === "Feed"}><FeedExample /></Match>
            <Match when={layout() === "Form"}><FormExample /></Match>
          </MatchSwitch>
        </div>
      </div>
    </div>
  );
}

function TokensPage() {
  return (
    <div class="page-stack">
      <SectionHeading
        eyebrow="03 / TOKENS"
        title="A system with voltage."
        copy="Neutral foundations keep personal apps flexible; signal colors make system state unmistakable."
      />
      <div class="token-layout">
        <For each={tokenGroups}>
          {(group) => (
            <Card class="token-card">
              <div class="token-card__title">{group.title}</div>
              <For each={group.tokens}>
                {(token) => (
                  <div class="token-row">
                    <span class="token-swatch" style={{ background: token[2] }} />
                    <span><strong>{token[0]}</strong><code>{token[1]}</code></span>
                    <button aria-label={`Copy ${token[1]}`}><Copy size={15} /></button>
                  </div>
                )}
              </For>
            </Card>
          )}
        </For>
        <Card class="type-specimen">
          <span class="token-card__title">TYPE SCALE</span>
          <div class="type-row type-row--display"><span>DISPLAY / 40</span><strong>Make it yours.</strong></div>
          <div class="type-row type-row--title"><span>TITLE / 28</span><strong>Daily digest</strong></div>
          <div class="type-row type-row--body"><span>BODY / 16</span><strong>Four messages need your attention today.</strong></div>
          <div class="type-row type-row--label"><span>LABEL / 11</span><strong>SYSTEM STATUS / READY</strong></div>
        </Card>
        <Card class="geometry-card">
          <span class="token-card__title">GEOMETRY</span>
          <div class="geometry-grid">
            <div><span class="geometry-shape geometry-shape--zero" /><strong>0</strong><small>Structural</small></div>
            <div><span class="geometry-shape geometry-shape--two" /><strong>2PX</strong><small>Controls</small></div>
            <div><span class="geometry-shape geometry-shape--pill" /><strong>FULL</strong><small>Status only</small></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function App() {
  const [section, setSection] = createSignal<Section>("Components");
  const [theme, setTheme] = createSignal<Theme>("light");
  const [mobileMenu, setMobileMenu] = createSignal(false);

  onMount(() => {
    const saved = localStorage.getItem("hyos-theme") as Theme | null;
    const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(saved ?? preferred);
    document.documentElement.dataset.theme = saved ?? preferred;
  });

  const toggleTheme = () => {
    const next = theme() === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("hyos-theme", next);
  };

  const selectSection = (next: Section) => {
    setSection(next);
    setMobileMenu(false);
  };

  return (
    <div class="sandbox-shell">
      <header class="topbar">
        <div class="brand-mark"><span>H</span></div>
        <div class="brand-copy"><strong>HYOS</strong><span>DESIGN SYSTEM / 0.1</span></div>
        <div class="topbar__rule" />
        <Badge tone="success">SYSTEM ONLINE</Badge>
        <div class="topbar__actions">
          <IconButton class="desktop-only" aria-label="Search"><Search size={18} /></IconButton>
          <ThemeToggle theme={theme()} onToggle={toggleTheme} />
          <IconButton class="mobile-only" aria-label="Open navigation" onClick={() => setMobileMenu(!mobileMenu())}>
            <Show when={!mobileMenu()} fallback={<X size={19} />}><Menu size={19} /></Show>
          </IconButton>
        </div>
      </header>

      <div class="sandbox-body">
        <aside classList={{ sidebar: true, "is-open": mobileMenu() }}>
          <nav aria-label="Sandbox sections">
            <span class="nav-label">LIBRARY</span>
            <For each={sections}>
              {(item, index) => (
                <button classList={{ "is-active": section() === item.name }} onClick={() => selectSection(item.name)}>
                  <span class="nav-index">0{index() + 1}</span>
                  <item.icon size={18} />
                  <strong>{item.name}</strong>
                  <ChevronRight class="nav-arrow" size={16} />
                </button>
              )}
            </For>
          </nav>
          <div class="sidebar__footer">
            <div class="pulse-dot" />
            <span><strong>WORKSPACE</strong><small>hyos-components</small></span>
          </div>
        </aside>

        <main>
          <MatchSwitch>
            <Match when={section() === "Components"}><ComponentsPage /></Match>
            <Match when={section() === "Layouts"}><LayoutsPage /></Match>
            <Match when={section() === "Tokens"}><TokensPage /></Match>
          </MatchSwitch>
        </main>
      </div>
    </div>
  );
}
