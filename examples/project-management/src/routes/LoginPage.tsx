import { useNavigate } from "@solidjs/router";
import { ArrowRight, Database, ShieldCheck, Sparkles } from "lucide-solid";
import { For } from "solid-js";

import { useAuth } from "../auth.js";
import { demoPeople, initialWorkspacePath } from "../demo-people.js";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();

  function signIn(userId: string) {
    auth.signIn(userId);
    navigate(initialWorkspacePath(userId), { replace: true });
  }

  return (
    <main class="login-page">
      <section class="login-panel">
        <div class="login-brand">
          <span class="brand-mark">
            <Sparkles size={18} />
          </span>
          <div>
            <strong>Northstar</strong>
            <small>Powered by HyApp</small>
          </div>
        </div>
        <div class="login-copy">
          <span class="login-eyebrow">
            <ShieldCheck size={14} /> Policy-aware demo
          </span>
          <h1>Choose your workspace identity</h1>
          <p>
            Each identity connects through the same gateway. The board only
            synchronizes projects its principal can read.
          </p>
        </div>
        <div class="identity-list">
          <For each={demoPeople}>
            {(person) => (
              <button
                class="identity-card"
                aria-label={`Continue as ${person.name}`}
                onClick={() => signIn(person.id)}
              >
                <span
                  class="avatar"
                  style={{ "background-color": person.color }}
                >
                  {person.initials}
                </span>
                <span>
                  <strong>{person.name}</strong>
                  <small>{person.id}</small>
                </span>
                <ArrowRight size={17} />
              </button>
            )}
          </For>
        </div>
        <div class="login-footnote">
          <Database size={14} /> Demo identities are translated into principal
          context by the HTTP gateway adapter.
        </div>
      </section>
      <aside class="login-visual" aria-hidden="true">
        <div class="login-orbit orbit-one" />
        <div class="login-orbit orbit-two" />
        <div class="login-engine">
          <span class="pulse-dot" />
          <strong>Authorized sync</strong>
          <small>read policies active</small>
        </div>
      </aside>
    </main>
  );
}
