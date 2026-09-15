import { For, Show, createMemo, onCleanup, type Component } from "solid-js";

import { supportsIncremental } from "./mode-selection.js";
import {
  duplicateFolderNames,
  folderName,
  folderPathPrefix,
  truncatePathStart,
} from "./sessions-model.js";
import type { AppState } from "./app-state.js";

export type NewSessionPageProps = Readonly<{
  app: AppState;
}>;

/** The new-session route: starter prompt, folder picker, and model picker. */
export const NewSessionPage: Component<NewSessionPageProps> = (props) => {
  const { app } = props;
  let modelPicker: HTMLDivElement | undefined;
  let folderPicker: HTMLDivElement | undefined;

  const closeMenusOnPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && !modelPicker?.contains(event.target)) {
      if (app.modelMenuOpen()) app.setModelMenuOpen(false);
    }
    if (
      event.target instanceof Node &&
      !folderPicker?.contains(event.target) &&
      app.folderMenuOpen()
    ) {
      app.setFolderMenuOpen(false);
    }
  };
  const closeMenusOnKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      app.setModelMenuOpen(false);
      app.setFolderMenuOpen(false);
    }
  };

  // Recent folders sharing a name need their path shown to stay distinguishable.
  const duplicateNames = createMemo(() =>
    duplicateFolderNames(app.recentFoldersList()),
  );
  document.addEventListener("pointerdown", closeMenusOnPointerDown);
  document.addEventListener("keydown", closeMenusOnKeyDown);
  onCleanup(() => {
    document.removeEventListener("pointerdown", closeMenusOnPointerDown);
    document.removeEventListener("keydown", closeMenusOnKeyDown);
  });

  return (
    <section class="welcome">
      <div class="welcome-card">
        <h2 class="welcome-title">New session</h2>
        <div class="starter">
          <textarea
            id="agent-start-prompt"
            class="prompt"
            value={app.prompt()}
            onInput={(event) => app.setPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void app.startSession();
              }
            }}
            placeholder="What do you want to work on?"
            autofocus
          />
          <div class="starter-controls">
            <div class="folder-picker" ref={folderPicker}>
              <button
                class="folder-button"
                type="button"
                aria-label="Choose folder"
                aria-haspopup="dialog"
                aria-expanded={app.folderMenuOpen()}
                onClick={() => app.setFolderMenuOpen((open) => !open)}
                title={app.folder() || "Choose folder"}
              >
                {app.folder() ? folderName(app.folder()) : "Choose folder"}
                <i aria-hidden="true">▾</i>
              </button>
              <Show when={app.folderMenuOpen()}>
                <div
                  class="folder-menu"
                  role="dialog"
                  aria-label="Choose folder"
                >
                  <button
                    class="folder-menu-new"
                    type="button"
                    onClick={() => {
                      app.setFolderMenuOpen(false);
                      void app.chooseFolder();
                    }}
                  >
                    Choose new folder…
                  </button>
                  <Show
                    when={app.recentFoldersList().length > 0}
                    fallback={
                      <div class="folder-menu-empty">No recent folders</div>
                    }
                  >
                    <div class="folder-menu-list">
                      <div class="folder-menu-title">Recent Folders</div>
                      <For each={app.recentFoldersList()}>
                        {(recent) => (
                          <button
                            class="folder-menu-item"
                            type="button"
                            classList={{ selected: recent === app.folder() }}
                            title={recent}
                            onClick={() => {
                              app.setFolder(recent);
                              app.setFolderMenuOpen(false);
                            }}
                          >
                            <span>{folderName(recent)}</span>
                            <Show
                              when={duplicateNames().has(folderName(recent))}
                            >
                              <span class="folder-menu-item-path">
                                {truncatePathStart(folderPathPrefix(recent))}/
                              </span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
            <label
              class="worktree-toggle"
              title={
                app.worktreeDefault()
                  ? "New sessions in this folder start in a git worktree"
                  : "Start new sessions for this folder in a git worktree"
              }
            >
              <input
                type="checkbox"
                checked={app.worktreeDefault()}
                disabled={!app.folder()}
                onChange={(event) =>
                  app.setFolderWorktree(event.currentTarget.checked)
                }
              />
              <span>Worktree</span>
            </label>
            <div class="model-picker" ref={modelPicker}>
              <button
                id="agent-model-picker"
                class="model-picker-trigger"
                type="button"
                aria-label="Choose model"
                aria-haspopup="dialog"
                aria-expanded={app.modelMenuOpen()}
                onClick={() => app.setModelMenuOpen((open) => !open)}
              >
                <span>{app.selectedModel()?.label ?? "Choose model"}</span>
                <Show
                  when={
                    app.initialMode() === "incremental"
                      ? "incremental"
                      : app.reasoningEffort()
                  }
                >
                  {(effort) => <small>· {effort()}</small>}
                </Show>
                <i aria-hidden="true">▾</i>
              </button>
              <Show when={app.modelMenuOpen()}>
                <div
                  class="model-menu"
                  role="dialog"
                  aria-label="Model settings"
                >
                  <div class="model-menu-title">Choose a model</div>
                  <div class="model-menu-list">
                    <For each={app.providers()}>
                      {(provider) => (
                        <section class="model-provider-group">
                          <div class="model-provider-label">
                            {provider.label}
                          </div>
                          <For each={provider.models}>
                            {(model) => (
                              <button
                                type="button"
                                class="model-option"
                                classList={{
                                  selected:
                                    provider.id === app.providerId() &&
                                    model.id === app.modelId(),
                                }}
                                onClick={() => {
                                  app.setProviderId(provider.id);
                                  app.setModelId(model.id);
                                }}
                              >
                                <span>{model.label}</span>
                                <Show
                                  when={
                                    provider.id === app.providerId() &&
                                    model.id === app.modelId()
                                  }
                                >
                                  <i aria-hidden="true">✓</i>
                                </Show>
                              </button>
                            )}
                          </For>
                        </section>
                      )}
                    </For>
                  </div>
                  <Show when={app.selectedModel()?.reasoningEfforts}>
                    {(efforts) => (
                      <div class="reasoning-picker">
                        <span>Reasoning</span>
                        <div class="reasoning-options">
                          <Show when={supportsIncremental(app.providerId())}>
                            <button
                              type="button"
                              class="incremental-option"
                              classList={{
                                selected: app.initialMode() === "incremental",
                              }}
                              title="Work in small, reviewable iterations with low reasoning. Saved when you send."
                              onClick={() => {
                                app.setMode(false, "incremental");
                                app.setReasoningEffort("low");
                              }}
                            >
                              incremental
                            </button>
                          </Show>
                          <For each={efforts()}>
                            {(effort) => (
                              <button
                                type="button"
                                classList={{
                                  selected:
                                    app.initialMode() === "incremental"
                                      ? false
                                      : app.reasoningEffort() === effort,
                                }}
                                onClick={() => {
                                  app.setReasoningEffort(effort);
                                  if (app.initialMode() === "incremental")
                                    app.setMode(false, "standard");
                                }}
                              >
                                {effort}
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </Show>
                </div>
              </Show>
            </div>
            <button
              id="agent-start"
              class="primary"
              type="button"
              disabled={
                app.submitting() ||
                !app.prompt().trim() ||
                !app.folder() ||
                !app.modelId()
              }
              onClick={() => void app.startSession()}
            >
              {app.submitting() ? "Starting…" : "Start session"}
            </button>
          </div>
          <Show when={app.error()}>
            {(value) => <div class="inline-error">{value()}</div>}
          </Show>
        </div>
      </div>
    </section>
  );
};
