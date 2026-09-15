export const agentStyles = String.raw`
  :root {
    color-scheme: dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #eceae5;
  }
  * { box-sizing: border-box; }
  html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  button, textarea, select, input { font: inherit; }
  button { color: inherit; }
  .agent-app {
    display: grid;
    grid-template-columns: 278px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    position: relative;
    width: 100%;
    height: 100%;
  }
  .window-drag-region {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 20px;
    z-index: 10;
    background: transparent;
    app-region: drag;
    -webkit-app-region: drag;
    user-select: none;
  }
  .agent-sidebar {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-right: 1px solid #30312d;
    background: #20211e;
  }
  .sidebar-head { padding: 20px 16px 14px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .brand-mark {
    display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px;
    color: #171816; background: #d9ff62; font-weight: 850; letter-spacing: -0.08em;
  }
  .brand strong { font-size: 14px; letter-spacing: .02em; }
  .brand-new, .primary, .folder-button, .send, .cancel {
    border: 0; border-radius: 9px; cursor: pointer; transition: background .15s, opacity .15s;
  }
  .brand-new {
    display: grid; place-items: center; width: 24px; height: 24px; padding: 0;
    color: #b5b7ac; background: transparent;
  }
  .brand-new-icon { width: 15px; height: 15px; }
  .brand-new:hover { background: #3b3d37; color: #e3e2dc; }
  .brand-new-wrap { position: relative; margin-left: auto; }
  .brand-new-wrap.open .brand-new { background: #30312d; color: #e3e2dc; }
  .popover-panel {
    display: flex; flex-direction: column; min-width: 180px; max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px); overflow-y: auto; z-index: 70;
    padding: 6px; border: 1px solid #3b3d37; border-radius: 10px;
    background: #262722; box-shadow: 0 12px 32px rgba(0, 0, 0, .5);
  }
  .modal-overlay {
    position: fixed; inset: 0; z-index: 60;
    display: flex; align-items: flex-start; justify-content: center;
    padding: 14vh 16px 16px;
    background: rgba(9, 10, 8, .55);
  }
  .modal-panel {
    display: flex; flex-direction: column; width: 380px; max-width: 100%;
    overflow: hidden; border: 1px solid #3b3d37; border-radius: 12px;
    background: #262722; box-shadow: 0 16px 48px rgba(0, 0, 0, .5);
  }
  .create-input {
    flex: none; padding: 12px 14px; border: 0; border-bottom: 1px solid #3b3d37;
    color: #eceae5; background: transparent; outline: none; font-size: 13px;
  }
  .create-input::placeholder { color: #85877e; }
  .create-list { display: flex; flex-direction: column; gap: 2px; padding: 6px; }
  .create-item {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border: 0; border-radius: 8px;
    color: #e3e2dc; background: transparent; cursor: pointer; text-align: left;
    transition: background .12s;
  }
  .create-item:hover, .create-item.selected { background: #34362f; }
  .create-item-icon { flex: none; width: 16px; color: #b5b7ac; text-align: center; }
  .create-item-text { display: flex; flex-direction: column; min-width: 0; }
  .create-item-text strong { font-size: 13px; font-weight: 600; }
  .create-item-hint { color: #85877e; font-size: 11px; }
  .create-empty { padding: 10px 12px 12px; color: #85877e; font-size: 12px; }
  .global-tabs { border-bottom: 1px solid #30312d; }
  .global-tabs-head {
    display: flex; align-items: center; justify-content: space-between;
    padding-right: 10px;
  }
  .global-tabs-label { flex: 1; }
  .global-tab-list { display: flex; flex-direction: column; gap: 2px; padding: 0 8px 8px; }
  .global-tab-row { display: flex; align-items: center; border-radius: 8px; }
  .global-tab-row:hover { background: #292a27; }
  .global-tab-row.active { background: #34362f; }
  .global-tab {
    flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 10px; border: 0; color: #aaaca2; background: transparent;
    cursor: pointer; font-size: 12px; text-align: left;
  }
  .global-tab:hover, .global-tab-row.active .global-tab { color: #e3e2dc; }
  .global-tab-close {
    flex: none; display: grid; place-items: center; width: 22px; height: 22px;
    margin: 0 5px 0 2px; border: 0; border-radius: 6px; color: #8e9087;
    background: transparent; cursor: pointer; font-size: 14px; line-height: 1;
    opacity: 0; transition: opacity .12s, background .12s, color .12s;
  }
  .global-tab-row:hover .global-tab-close,
  .global-tab-row:focus-within .global-tab-close { opacity: 1; }
  .global-tab-close:hover { color: #eceae5; background: #3b3d37; }
  .session-label {
    padding: 8px 18px; color: #85877e; font-size: 11px; font-weight: 700;
    letter-spacing: .09em; text-transform: uppercase;
  }
  .session-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 18px; }
  .sidebar-footer { display: flex; align-items: center; gap: 6px; flex: none; border-top: 1px solid #30312d; padding: 8px 10px; }
  .archive-open {
    position: relative;
    display: grid; place-items: center;
    width: 28px; height: 28px; margin: 0 0 0 auto; padding: 0;
    border: 0; border-radius: 8px;
    color: #ffffff; background: transparent; cursor: pointer;
    transition: background .12s, color .12s;
  }
  .archive-open:hover { background: #3b3d37; }
  .archive-open.active { color: #b2cb8c; }
  .archive-open:focus-visible { outline: 2px solid #b2cb8c; }
  .sound-toggle {
    position: relative;
    display: grid; place-items: center;
    width: 28px; height: 28px; margin: 0; padding: 0;
    border: 0; border-radius: 8px;
    color: #ffffff; background: transparent; cursor: pointer;
    transition: background .12s, color .12s;
  }
  .sound-toggle:hover { background: #3b3d37; }
  .sound-toggle:focus-visible { outline: 2px solid #b2cb8c; }
  .sound-toggle-icon { width: 16px; height: 16px; }
  .sound-toggle-tip {
    position: absolute; bottom: calc(100% + 8px); left: 0;
    z-index: 80; display: none;
    padding: 4px 8px; border-radius: 6px;
    color: #eceae5; background: #3b3d37;
    box-shadow: 0 6px 20px rgba(0, 0, 0, .45);
    font-size: 11px; white-space: nowrap; pointer-events: none;
  }
  .sound-toggle:hover .sound-toggle-tip,
  .sound-toggle:focus-visible .sound-toggle-tip { display: block; }
  .session-folder-group + .session-folder-group { margin-top: 2px; }
  .session-folder-heading { display: flex; align-items: center; gap: 4px; margin: 0; padding: 8px 10px 4px; color: #b5b7ac; font-size: 12px; font-weight: 600; cursor: grab; user-select: none; }
  .session-folder-heading.dragging { cursor: grabbing; opacity: 0; user-select: none; }
  .session-folder-heading.drag-ghost {
    position: fixed; left: 0; top: 0; z-index: 60; margin: 0;
    padding: 6px 10px; color: #eceae5; background: #3b3d37;
    border-radius: 8px; box-shadow: 0 12px 32px rgba(0, 0, 0, .45);
    pointer-events: none;
  }
  .session-folder-heading.drag-ghost .session-folder-parent { display: none; }
  .session-folder-toggle {
    flex: none; display: flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; margin-left: -4px; padding: 0;
    border: 0; border-radius: 5px; background: transparent; cursor: pointer;
    color: inherit; font-size: 11px; line-height: 1;
  }
  .session-folder-toggle:hover { color: #eceae5; background: #30312d; }
  .session-folder-icon { width: 14px; height: 14px; flex: none; }
  .session-folder-group.collapsed .session-folder-heading { padding-bottom: 8px; }
  /* Name/parent stay inline when collapsed; stacked block layout when open. */
  .session-folder-name, .session-folder-parent { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-folder-group.collapsed .session-folder-parent { display: none; }
  .session-folder-parent { margin-top: 3px; color: #85877e; font-size: 10px; font-weight: 400; }
  .session-row { display: flex; align-items: stretch; border-radius: 9px; }
  .session-open {
    flex: 1; min-width: 0; padding: 10px; border: 0; border-radius: 9px;
    text-align: left; background: transparent; cursor: pointer;
  }
  .session-row:hover { background: #292a27; }
  .session-row.active { background: #34362f; }
  .session-row.dragging { opacity: 0; user-select: none; }
  .session-row.drag-ghost {
    position: fixed; left: 0; top: 0; z-index: 60; margin: 0;
    background: #3b3d37; box-shadow: 0 12px 32px rgba(0, 0, 0, .45);
    pointer-events: none;
  }
  .session-archive {
    flex: none; align-self: center; width: 26px; height: 26px; margin: 0 5px 0 2px;
    border: 0; border-radius: 7px; color: #8e9087; background: transparent; cursor: pointer;
    font-size: 16px; line-height: 1; opacity: 0; transition: opacity .12s, background .12s, color .12s;
  }
  .session-row:hover .session-archive, .session-row:focus-within .session-archive { opacity: 1; }
  .session-archive:hover { color: #eceae5; background: #3b3d37; }
  .session-archive:focus-visible { outline: 2px solid #b2cb8c; }
  .session-row.archived .session-open { opacity: .62; }
  .session-row.archived:hover .session-open { opacity: .85; }
  .session-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 16px; }
  /* Same box and type as .session-title so entering inline rename does not
     shift the row; the underline comes from a shadow, keeping height fixed. */
  .session-title-input {
    display: block; width: 100%; min-width: 0; height: 16px; padding: 0; margin: 0;
    border: 0; border-radius: 0; background: transparent; color: inherit;
    font-size: 13px; line-height: 16px; white-space: nowrap;
    caret-color: #d9ff62; outline: none; cursor: text;
    box-shadow: 0 1px 0 #b2cb8c;
  }
  .session-meta { display: flex; gap: 7px; margin-top: 5px; color: #8e9087; font-size: 11px; align-items: center; }
  .session-spinner {
    flex: none; width: 9px; height: 9px; border-radius: 50%;
    border: 1.5px solid #d9ff6230; border-top-color: #d9ff62;
    animation: session-spin 0.8s linear infinite;
  }
  @keyframes session-spin { to { transform: rotate(360deg); } }
  .session-status-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-status-text.ready::before,
  .session-status-text.failed::before,
  .session-status-text.cancelled::before {
    content: ""; display: inline-block; flex: none; width: 5px; height: 5px;
    border-radius: 50%; background: currentColor; margin-right: 6px;
    vertical-align: 1px;
  }
  .session-status-text.running { color: #d9ff62; }
  .session-status-text.ready { color: #6ea8fe; }
  /* Outcome already viewed (session was opened since this run finished):
     fade to a gray subtler than the white session title. */
  .session-status-text.ready.seen { color: #83867c; }
  .session-status-text.failed { color: #ff6f61; }
  .session-status-text.cancelled { color: #c5a46d; }
  .agent-main { min-width: 0; min-height: 0; }
  .global-browser { display: flex; width: 100%; height: 100%; min-height: 0; }
  .welcome { display: grid; place-items: center; width: 100%; height: 100%; padding: 38px; overflow-y: auto; }
  .welcome-card { width: min(760px, 100%); }
  .archive-page { display: flex; justify-content: center; width: 100%; height: 100%; min-height: 0; padding: 22px 26px; }
  .archive-column { display: flex; flex-direction: column; width: 100%; max-width: 880px; min-height: 0; }
  .archive-header { display: flex; align-items: center; gap: 12px; padding-bottom: 18px; }
  .archive-title { margin: 0; font-size: 15px; font-weight: 600; color: #eceae5; }
  .archive-body { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; }
  .archive-search {
    flex: 1; max-width: 340px; margin-left: auto; height: 28px; padding: 0 10px;
    border: 1px solid #3b3d37; border-radius: 8px;
    color: #f2f0ea; background: #292a27; font-size: 12px; outline: none;
  }
  .archive-search:focus { border-color: #55584e; background: #30312d; }
  .archive-search:focus-visible { outline: 2px solid #b2cb8c; outline-offset: -2px; }
  .archive-group { padding-bottom: 10px; }
  .archive-group-label { margin: 0; padding: 8px 10px 4px; color: #777a71; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .archive-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
  .archive-row {
    display: flex; align-items: baseline; gap: 10px;
    padding: 9px 10px; border-radius: 8px; font-size: 13px;
  }
  .archive-row:hover { background: #262723; }
  .archive-row-open {
    display: flex; align-items: baseline; gap: 10px; flex: 1; min-width: 0;
    padding: 0; border: 0; background: transparent; cursor: pointer; text-align: left; font: inherit;
  }
  .archive-row-open:focus-visible { outline: 2px solid #b2cb8c; outline-offset: 2px; border-radius: 4px; }
  .archive-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f2f0ea; }
  .archive-row-folder { flex: none; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #777a71; font-size: 11px; }
  .archive-row-unarchive {
    flex: none; align-self: center; width: 26px; height: 26px; margin: 0; padding: 0;
    border: 0; border-radius: 7px; color: #8e9087; background: transparent; cursor: pointer;
    font-size: 14px; line-height: 1; opacity: 0; transition: opacity .12s, background .12s, color .12s;
  }
  .archive-row:hover .archive-row-unarchive, .archive-row:focus-within .archive-row-unarchive { opacity: 1; }
  .archive-row-unarchive:hover { color: #eceae5; background: #3b3d37; }
  .archive-row-unarchive:focus-visible { outline: 2px solid #b2cb8c; }
  .archive-sentinel { height: 1px; }
  .archive-empty { padding: 26px 0; color: #777a71; font-size: 12px; text-align: center; }
  .starter { padding: 18px; border: 1px solid #343630; border-radius: 16px; background: #20211e; }
  .prompt {
    width: 100%; min-height: 126px; resize: vertical; padding: 2px; border: 0; outline: 0;
    color: #f2f0ea; background: transparent; line-height: 1.55;
  }
  .starter-controls { display: flex; align-items: center; gap: 10px; padding-top: 14px; border-top: 1px solid #33342f; }
  .folder-button, .model-picker-trigger { height: 38px; }
  .folder-button { border: 1px solid #3b3d37; background: #292a27; }
  .folder-button { min-width: 0; max-width: 300px; padding: 0 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folder-picker { position: relative; }
  .folder-button {
    display: flex; align-items: center; gap: 4px; max-width: 220px; padding: 0 8px 0 10px;
    border-radius: 8px; color: #d7d6d0; cursor: pointer; font-size: 11px;
  }
  .folder-button:hover, .folder-button[aria-expanded="true"] { border-color: #55584e; background: #30312d; }
  .folder-button > i { flex: none; margin-left: 3px; color: #777a71; font-size: 10px; font-style: normal; }
  .folder-menu {
    position: absolute; z-index: 20; bottom: calc(100% + 8px); left: 0; width: 292px; max-height: min(430px, calc(100vh - 170px));
    overflow: hidden; border: 1px solid #41433c; border-radius: 12px; background: #242521;
    box-shadow: 0 18px 50px #0009, 0 2px 8px #0007;
  }
  .folder-menu-new {
    display: block; width: 100%; padding: 11px 13px; border: 0; border-bottom: 1px solid #343630;
    color: #d7d6d0; background: transparent; cursor: pointer; text-align: left; font-size: 12px;
  }
  .folder-menu-new:hover { background: #2c2e28; }
  .folder-menu-list { max-height: 260px; overflow-y: auto; padding: 7px; }
  .folder-menu-empty { padding: 10px 13px 12px; color: #777a71; font-size: 11px; }
  .folder-menu-item {
    display: block; width: 100%; min-height: 32px; padding: 6px 8px; border: 0; border-radius: 7px;
    color: #c9c8c2; background: transparent; cursor: pointer; text-align: left; font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .folder-menu-item:hover { background: #30322d; }
  .folder-menu-item.selected { color: #eff0e8; background: #36382f; }
  .model-picker { position: relative; }
  .model-picker-trigger {
    display: flex; align-items: center; gap: 4px; max-width: 220px; padding: 0 8px 0 10px;
    border: 1px solid #3b3d37; border-radius: 8px; color: #d7d6d0; background: #292a27; cursor: pointer;
    font-size: 11px;
  }
  .model-picker-trigger:hover, .model-picker-trigger[aria-expanded="true"] { border-color: #55584e; background: #30312d; }
  .model-picker-trigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model-picker-trigger small { flex: none; color: #92958b; font-size: 10px; text-transform: capitalize; }
  .model-picker-trigger > i { flex: none; margin-left: 3px; color: #777a71; font-size: 10px; font-style: normal; }
  .model-menu {
    position: absolute; z-index: 20; bottom: calc(100% + 8px); left: 0; width: 292px; max-height: min(430px, calc(100vh - 170px));
    overflow: hidden; border: 1px solid #41433c; border-radius: 12px; background: #242521;
    box-shadow: 0 18px 50px #0009, 0 2px 8px #0007;
  }
  .model-menu-title { padding: 12px 13px 9px; color: #8f9288; font-size: 10px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  .model-menu-list { max-height: 290px; overflow-y: auto; padding: 0 7px 7px; }
  .model-provider-group + .model-provider-group { margin-top: 6px; padding-top: 7px; border-top: 1px solid #343630; }
  .model-provider-label { padding: 4px 7px 5px; color: #777a71; font-size: 10px; font-weight: 650; }
  .model-option {
    display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 32px; padding: 6px 8px;
    border: 0; border-radius: 7px; color: #c9c8c2; background: transparent; cursor: pointer; text-align: left; font-size: 12px;
  }
  .model-option:hover { background: #30322d; }
  .model-option.selected { color: #eff0e8; background: #36382f; }
  .model-option i { color: #d9ff62; font-size: 11px; font-style: normal; }
  .reasoning-picker { padding: 10px 12px 12px; border-top: 1px solid #3a3c35; background: #20211e; }
  .reasoning-picker > span { display: block; margin-bottom: 8px; color: #85887e; font-size: 10px; font-weight: 650; }
  .reasoning-options { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
  .reasoning-options button {
    height: 28px; padding: 0 6px; border: 1px solid transparent; border-radius: 6px; color: #92958b;
    background: #2b2c28; cursor: pointer; font-size: 10px; text-transform: capitalize;
  }
  .reasoning-options button:hover { color: #d7d8d0; background: #35372f; }
  .reasoning-options button.selected { border-color: #66763b; color: #e4f7a9; background: #384126; }
  .primary, .send { margin-left: auto; padding: 10px 16px; color: #171816; background: #d9ff62; font-weight: 760; }
  .primary:hover, .send:hover { background: #e5ff91; }
  button:disabled { cursor: not-allowed; opacity: .42; }
  .inline-error { margin: 12px 2px 0; color: #ff8f83; font-size: 13px; white-space: pre-wrap; }
  .conversation {
    display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100%;
  }
  .conversation.side-open { grid-template-columns: minmax(0, 1fr) min(var(--patch-panel-width, 520px), calc(100% - 360px)); }
  .conversation.side-collapsed { grid-template-columns: minmax(0, 1fr) auto; }
  .conversation-head { display: flex; align-items: center; gap: 12px; padding: 16px 22px; border-bottom: 1px solid #2b2c28; }
  .conversation-title { min-width: 0; }
  .conversation-title strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conversation-title span { color: #898b82; font-size: 12px; }
  .cancel { margin-left: auto; padding: 8px 11px; color: #ffb0a8; background: #3a2826; }
  .browser-panel-toolbar {
    display: flex; align-items: center; gap: 6px;
    min-height: 47px; padding: 8px 12px;
    border-bottom: 1px solid #30312d; background: #1d1e1b;
  }
  .browser-nav {
    flex: none; display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
    border: 0; border-radius: 7px; color: #8e9087; background: transparent;
    cursor: pointer; font-size: 15px; line-height: 1;
  }
  .browser-nav:hover:not(:disabled) { color: #eceae5; background: #30312d; }
  .browser-address {
    flex: 1; min-width: 0; height: 28px; padding: 0 10px;
    border: 1px solid #3a3c35; border-radius: 8px; outline: 0;
    color: #eceae5; background: #20211e; font-size: 12px;
  }
  .browser-address::placeholder { color: #6f7268; }
  .browser-address:focus { border-color: #55584e; }
  .browser-panel-stage { position: relative; flex: 1; min-height: 0; }
  .browser-panel-view { position: absolute; inset: 0; }
  .browser-panel-empty {
    display: grid; place-items: center; gap: 12px; height: 100%;
    color: #72746c; font-size: 12px;
  }
  .browser-panel-empty p { margin: 0; }
  .browser-panel-error {
    overflow: hidden; padding: 6px 12px; border-top: 1px solid #3f2c29;
    color: #ff8f83; font-size: 11px; text-overflow: ellipsis; white-space: nowrap;
  }
  .transcript { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; font-size: 14px; }
  .messages { width: min(820px, calc(100% - 44px)); margin: 0 auto; padding: 34px 0 26px; }
  .loading-older { padding: 8px 0 22px; color: #7f8178; text-align: center; font-size: 12px; }
  .message { margin-bottom: 28px; content-visibility: auto; contain-intrinsic-size: auto 140px; }
  .message.user { padding-left: 12%; }
  .message.user .message-body { padding: 13px 15px; border-radius: 13px; background: #292b26; }
  .message.assistant .message-body { color: #dddcd6; }
  .message.commentary { margin-bottom: 16px; color: #c9c8c1; }
  .message.commentary .message-body { line-height: 1.55; }
  /* A run of agent activity (thinking + commands) is capped so the previous
     prompt stays visible while the agent works; it scrolls internally and
     stays pinned to its newest content. */
  .activity-capped {
    max-height: 80vh; overflow-y: auto; overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .message-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.62; }
  .markdown { white-space: normal; }
  .markdown > :first-child { margin-top: 0; }
  .markdown > :last-child { margin-bottom: 0; }
  .markdown p, .markdown ul, .markdown ol, .markdown blockquote, .markdown pre { margin: 0 0 14px; }
  .markdown h1, .markdown h2, .markdown h3, .markdown h4 {
    margin: 24px 0 10px; line-height: 1.25; letter-spacing: -.02em;
  }
  .markdown h1 { font-size: 24px; }
  .markdown h2 { font-size: 20px; }
  .markdown h3 { font-size: 16px; }
  .markdown ul, .markdown ol { padding-left: 24px; }
  .markdown li + li { margin-top: 5px; }
  .markdown blockquote { padding-left: 14px; border-left: 2px solid #4c4f45; color: #aaaCA2; }
  .markdown code {
    padding: 2px 5px; border-radius: 5px; background: #292b26;
    font: .88em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .markdown pre { overflow-x: auto; padding: 13px 15px; border: 1px solid #34362f; border-radius: 10px; background: #121310; }
  .markdown pre code { padding: 0; background: transparent; font-size: 12px; }
  .markdown a { color: #c8e96a; text-decoration-color: #6f803f; text-underline-offset: 3px; }
  .markdown hr { margin: 22px 0; border: 0; border-top: 1px solid #34362f; }
  .markdown table { display: block; width: max-content; max-width: 100%; margin: 0 0 14px; overflow-x: auto; border-collapse: collapse; }
  .markdown th, .markdown td { padding: 6px 11px; border: 1px solid #34362f; vertical-align: top; }
  .markdown th:not([align]) { text-align: left; }
  .markdown thead th { background: #292b26; font-weight: 600; white-space: nowrap; }
  .mermaid-diagram {
    position: relative; overflow-x: auto; min-height: 96px;
    margin: 0 0 14px; padding: 18px;
    border: 1px solid #34362f; border-radius: 10px; background: #121310;
  }
  .mermaid-diagram.rendering {
    display: grid; place-items: center;
    color: #85877e; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .mermaid-diagram svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
  .mermaid-diagram.error p { margin: 0 0 9px; color: #e49a9f; font: 11px Inter, sans-serif; }
  .mermaid-diagram.error pre { margin: 0; }
  .mermaid-fullscreen-button {
    position: absolute; top: 8px; right: 8px;
    display: grid; place-items: center; width: 30px; height: 30px; padding: 0;
    border: 1px solid #3b3d37; border-radius: 6px; background: #20221edd; color: #c9cbc1;
    font: 17px/1 Inter, sans-serif; cursor: pointer; opacity: 0;
    transition: border-color 120ms ease, opacity 120ms ease;
  }
  .mermaid-diagram:hover .mermaid-fullscreen-button,
  .mermaid-fullscreen-button:focus-visible { opacity: 1; }
  .mermaid-fullscreen-button:hover { border-color: #55584f; }
  .mermaid-viewer {
    position: fixed; z-index: 1000; inset: 0;
    display: grid; grid-template-rows: auto 1fr;
    background: #0c0d0bef; backdrop-filter: blur(6px);
  }
  .mermaid-viewer-toolbar {
    z-index: 1; display: flex; align-items: center; justify-content: flex-end; gap: 10px;
    min-height: 52px; padding: 8px 14px;
    border-bottom: 1px solid #30312d; background: #171816e8;
  }
  .mermaid-viewer-toolbar button {
    min-width: 58px; height: 32px; padding: 0 11px; cursor: pointer;
    border: 1px solid #3b3d37; border-radius: 6px; background: #24251f; color: #d5d6ce;
    font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .mermaid-viewer-toolbar .mermaid-viewer-close { min-width: 32px; width: 32px; padding: 0; font: 20px/1 Inter, sans-serif; }
  .mermaid-viewer-hint { margin-right: auto; color: #85877e; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .mermaid-viewer-stage {
    position: relative; overflow: hidden; min-width: 0; min-height: 0;
    overscroll-behavior: none; touch-action: none;
  }
  .mermaid-viewer-canvas {
    position: absolute; inset: 0; display: grid; place-items: center;
    transform-origin: center; will-change: transform;
  }
  .mermaid-viewer-canvas svg {
    display: block; width: auto !important; max-width: 92vw !important;
    height: auto !important; max-height: calc(100vh - 92px) !important;
  }
  .tool-group { margin: -2px 0 20px; color: #8e9087; font-size: 12px; }
  .work-pane { margin: 14px 0 20px; color: #8e9087; font-size: 12px; }
  .work-pane > summary {
    display: flex; align-items: center; gap: 7px; width: fit-content; padding: 4px 0;
    cursor: pointer; list-style: none; user-select: none;
  }
  .work-pane > summary::-webkit-details-marker { display: none; }
  .work-pane > summary:hover { color: #b9bbb1; }
  .work-pane-items { margin: 8px 0 0 9px; padding-left: 14px; border-left: 1px solid #353730; }
  .work-pane[open] > .work-pane-items {
    max-height: 80vh; overflow-y: auto; overscroll-behavior: contain;
  }
  .work-pane-items .tool-group:last-child,
  .work-pane-items .message.commentary:last-child { margin-bottom: 0; }
  .tool-group summary {
    display: flex; align-items: center; gap: 7px; width: fit-content; padding: 4px 0;
    cursor: pointer; list-style: none; user-select: none;
  }
  .tool-group summary::-webkit-details-marker { display: none; }
  .tool-group summary:hover { color: #b9bbb1; }
  .tool-chevron { display: inline-block; font-size: 17px; line-height: 12px; transition: transform .15s; }
  .tool-group[open] .tool-chevron { transform: rotate(90deg); }
  .tool-running { width: 5px; height: 5px; border-radius: 50%; background: #d9ff62; box-shadow: 0 0 7px #d9ff6270; }
  .tool-items { margin: 8px 0 0 9px; padding-left: 14px; border-left: 1px solid #353730; }
  .tool-item { padding: 5px 0 9px; }
  .tool-item strong { color: #aaaCA2; font-size: 11px; font-weight: 650; }
  .tool-item pre {
    max-height: 240px; margin: 6px 0 0; overflow: auto; white-space: pre-wrap;
    overflow-wrap: anywhere; color: #777a71; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .streaming-caret { display: inline-block; width: 7px; height: 15px; margin-left: 4px; vertical-align: -2px; background: #d9ff62; animation: blink .9s steps(1) infinite; }
  .message-error { margin-top: 8px; color: #ff8f83; font-size: 12px; }
  .plan-panel {
    margin: 4px 0 20px; padding: 13px 15px; border: 1px solid #30322c; border-radius: 10px;
    background: #1b1c19;
  }
  .plan-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .plan-toggle {
    display: inline-flex; align-items: center; gap: 7px; padding: 0; border: 0; background: none; cursor: pointer;
  }
  .plan-caret { color: #6f7268; font-size: 18px; line-height: 1; transform: translateY(-2px); }
  .plan-toggle:hover .plan-caret { color: #d9ff62; }
  .plan-toggle strong { color: #95978e; font-size: 10px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
  .plan-head > span { color: #6f7268; font-size: 10px; font-variant-numeric: tabular-nums; }
  .plan-show-all {
    display: block; margin: 10px 0 0; padding: 4px 0; border: 0; background: none;
    color: #6f7268; font-size: 11px; font-weight: 600; cursor: pointer; text-align: left;
  }
  .plan-show-all:hover { color: #b9bbb1; }
  .plan-tasks { display: grid; gap: 7px; margin: 10px 0 0; padding: 0; list-style: none; }
  .plan-tasks.faded { position: relative; margin-top: 0; }
  .plan-tasks.faded::before {
    content: ""; position: absolute; inset: 0 0 auto; height: 26px; z-index: 1;
    background: linear-gradient(#1b1c19, transparent); pointer-events: none;
  }
  .plan-task { display: flex; gap: 9px; color: #d5d4ce; font-size: 13px; line-height: 1.5; }
  .plan-num {
    flex: none; width: 18px; text-align: right; color: #6f7268;
    font: 11px/1.9 ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
  }
  .plan-task.next .plan-num { color: #b9bbb1; }
  .plan-task.done .plan-num { color: #4c4e47; }
  .plan-check {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; margin-top: 2px; border: 1px solid #3b3d37; border-radius: 5px;
    color: #10120e; font-size: 11px; line-height: 1;
  }
  .plan-task.next .plan-check { border-color: #d9ff62; }
  .plan-task.next .plan-text { color: #eceae5; }
  .plan-task.done { color: #72746c; }
  .plan-task.done .plan-text { text-decoration: line-through; }
  .plan-task.done .plan-check { border-color: #9dbb3c; background: #9dbb3c; }
  .plan-next {
    justify-self: start; margin: 3px 0 0 52px; max-width: 100%; padding: 7px 12px; border: 0; border-radius: 8px;
    overflow: hidden; color: #10120e; background: #d9ff62; font-size: 12px; font-weight: 650;
    text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
  }
  .plan-next:hover:not(:disabled) { background: #e4ff86; }
  .plan-next:disabled { opacity: .45; cursor: default; }
  .context-usage { color: #6f7268; font-size: 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  @keyframes blink { 50% { opacity: 0; } }
  .composer-shell { padding: 14px 22px 18px; background: linear-gradient(transparent, #171816 28%); }
  .composer { display: flex; flex-direction: column; width: min(820px, 100%); margin: auto; border: 1px solid #3a3c35; border-radius: 14px; background: #22231f; }
  .composer textarea { flex: 1; min-height: 42px; max-height: 160px; padding: 12px 14px 8px; resize: none; border: 0; outline: 0; color: #f2f0ea; background: transparent; }
  .composer-bar { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-top: 1px solid #33342f; }
  .composer-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .composer .model-picker { flex: none; }
  .composer .model-picker-trigger { height: 24px; gap: 5px; max-width: 220px; padding: 0 8px; border: 0; background: transparent; font-size: 11px; }
  .composer .model-picker-trigger small { font-size: 9px; }
  .composer .model-picker-trigger:hover, .composer .model-picker-trigger[aria-expanded="true"] { background: #2b2c29; }
  .composer .model-picker-trigger > i { font-size: 10px; transform: none; }
  .composer .send { margin: 0; padding: 4px 12px; font-size: 11px; }
  .composer .send.investigate { background: #33352e; color: #c9cbbf; font-weight: 600; }
  .composer .send.investigate:hover { background: #3c3e37; }
  .composer .send.secondary { background: #33352e; color: #c9cbbf; font-weight: 600; }
  .composer .send.secondary:hover:not(:disabled) { background: #3c3e37; }
  .composer .send.secondary:disabled { opacity: .55; cursor: default; }
  .side-pane {
    position: relative; grid-column: 2; grid-row: 1 / -1; display: flex; flex-direction: column; min-width: 0; min-height: 0;
    border-left: 1px solid #30312d; background: transparent;
  }
  .side-tabs {
    display: flex; align-items: center; gap: 6px;
    min-height: 47px; padding: 6px 8px 6px 10px;
    border-bottom: 1px solid #30312d; background: #1d1e1b;
  }
  .side-tab {
    display: inline-flex; align-items: center; gap: 6px;
    max-width: 170px; padding: 6px 10px; border: 1px solid #3a3c35; border-radius: 8px;
    color: #aaaca2; background: transparent; cursor: pointer; font-size: 12px;
  }
  .side-tab:hover, .side-tab.active { color: #e3e2dc; background: #292b26; }
  .side-tab.active { border-color: #4a4d43; }
  .side-tab-icon { flex: none; font-size: 13px; line-height: 1; }
  .side-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .side-tab-badge { flex: none; color: #d9ff62; font-size: 11px; }
  .side-tab-close {
    flex: none; display: grid; place-items: center; width: 16px; height: 16px;
    margin-right: -3px; border-radius: 5px; color: #8e9087; font-size: 12px; line-height: 1;
  }
  .side-tab-close:hover { color: #eceae5; background: #3f423a; }
  .side-tab-add {
    flex: none; display: grid; place-items: center; width: 26px; height: 26px; padding: 0;
    border: 1px solid #3a3c35; border-radius: 7px; color: #8e9087; background: transparent;
    cursor: pointer; font-size: 14px; line-height: 1;
  }
  .side-tab-add:hover { color: #eceae5; background: #292b26; }
  .cdp-inspect { position: relative; flex: none; }
  .menu-item {
    display: block; width: 100%; padding: 7px 10px; text-align: left; border: 0;
    border-radius: 7px; color: #c9c8c1; background: transparent; cursor: pointer; font-size: 12px;
  }
  .menu-item:hover { color: #eceae5; background: #34362f; }
  .cdp-inspect-popover {
    display: flex; flex-direction: column; gap: 8px;
  }
  .cdp-inspect-row { display: flex; gap: 6px; }
  .cdp-inspect-endpoint {
    flex: 1; min-width: 0; height: 26px; padding: 0 8px;
    border: 1px solid #3a3c35; border-radius: 7px; outline: 0;
    color: #eceae5; background: #1d1e1b; font-size: 11px;
  }
  .cdp-inspect-endpoint:focus { border-color: #55584e; }
  .cdp-inspect-go {
    padding: 0 10px; border: 0; border-radius: 7px;
    color: #171816; background: #d9ff62; cursor: pointer; font-size: 11px; font-weight: 700;
  }
  .cdp-inspect-go:hover { background: #e5ff91; }
  .cdp-inspect-error { color: #ff8f83; font-size: 11px; white-space: pre-wrap; }
  .cdp-inspect-empty { color: #72746c; font-size: 11px; }
  .cdp-inspect-targets { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }
  .cdp-inspect-target {
    display: flex; align-items: baseline; gap: 8px; padding: 6px 8px; text-align: left;
    border: 0; border-radius: 7px; color: #c9c8c1; background: transparent; cursor: pointer; font-size: 11px;
  }
  .cdp-inspect-target:hover { color: #eceae5; background: #2e3029; }
  .cdp-inspect-target-type { flex: none; color: #8e9087; font-size: 10px; text-transform: uppercase; }
  .cdp-inspect-target-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .side-collapse {
    margin-left: auto; display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
    border: 0; border-radius: 7px; color: #8e9087; background: transparent;
    cursor: pointer; font-size: 14px; line-height: 1;
  }
  .side-collapse:hover { color: #eceae5; background: #30312d; }
  .side-pane-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .browser-tab { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .side-pane.collapsed { width: 46px; }
  .side-pane.collapsed .patch-resize-handle { display: none; }
  .side-pane.collapsed .side-tabs {
    flex: 1; flex-direction: column; gap: 8px; min-height: 0; padding: 10px 8px;
    border-bottom: 0;
  }
  .side-pane.collapsed .side-collapse { order: -1; margin-left: 0; }
  .side-pane.collapsed .side-tab { padding: 8px; }
  .side-pane.collapsed .side-tab-label, .side-pane.collapsed .side-tab-badge,
  .side-pane.collapsed .side-tab-close { display: none; }
  .side-pane.collapsed .side-pane-body { display: none; }
  .patch-resize-handle {
    position: absolute; z-index: 2; top: 0; bottom: 0; left: -5px; width: 10px;
    cursor: col-resize; touch-action: none;
  }
  .patch-resize-handle::after {
    position: absolute; top: 0; bottom: 0; left: 4px; width: 2px; content: "";
    background: transparent; transition: background .15s;
  }
  .patch-resize-handle:hover::after, .resizing-patch-panel .patch-resize-handle::after { background: #8ca43f; }
  .resizing-patch-panel, .resizing-patch-panel * { cursor: col-resize !important; user-select: none !important; }
  .patch-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; background: #1d1e1b; }
  .patch-empty { padding: 24px 12px; color: #72746c; font-size: 12px; line-height: 1.5; text-align: center; }
  .patch-entry {
    margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #34362f;
    content-visibility: auto; contain-intrinsic-size: auto 180px;
  }
  .patch-entry p { margin: 0 0 11px; color: #d5d4ce; font-size: 12px; line-height: 1.5; }
  .patch-files { display: grid; gap: 5px; margin-bottom: 10px; }
  .patch-files span { overflow: hidden; color: #95978e; font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
  .patch-files i { color: #c8e96a; font-style: normal; }
  .diff-viewer {
    overflow: hidden; border: 1px solid #30322c; border-radius: 8px; cursor: pointer;
    background: #141512; font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .diff-viewer.unlocked { cursor: default; }
  .diff-toolbar {
    display: flex; align-items: center; justify-content: space-between; height: 30px; padding: 0 8px 0 10px;
    border-bottom: 1px solid #2b2d28; color: #777b72; background: #191a17; font: 10px/1 ui-sans-serif, system-ui, sans-serif;
  }
  .diff-toolbar button {
    padding: 4px 8px; border: 1px solid #3b3d37; border-radius: 5px; color: #b8baaf; background: #242520;
    cursor: pointer; font-size: 10px;
  }
  .diff-toolbar button:hover { color: #eceae5; background: #30322d; }
  .diff-body { max-height: 450px; overflow-x: auto; overflow-y: hidden; }
  .diff-viewer.unlocked .diff-body { overflow-y: auto; overscroll-behavior: contain; }
  .diff-error { padding: 7px 10px; border-top: 1px solid #3f2c29; color: #ff8f83; background: #281c1a; font: 10px/1.4 ui-sans-serif, system-ui, sans-serif; }
  .diff-hunk-gap { height: 7px; border-top: 1px solid #2b3538; background: #171d1f; }
  .diff-line { display: grid; grid-template-columns: 42px 42px 20px minmax(max-content, 1fr); min-width: 100%; width: max-content; }
  .diff-line-number { padding: 0 8px; color: #62655d; background: #191a17; text-align: right; user-select: none; }
  .diff-line-number.old { border-right: 1px solid #292b26; }
  .diff-marker { color: #696c63; text-align: center; user-select: none; }
  .diff-code { min-height: 17px; padding-right: 12px; color: #b8baaf; white-space: pre; }
  .diff-line.addition { background: #1d2a1d; }
  .diff-line.addition .diff-line-number { color: #789675; background: #1a251a; }
  .diff-line.addition .diff-marker { color: #82bd75; }
  .diff-line.removal { background: #2d1d1c; }
  .diff-line.removal .diff-line-number { color: #a57470; background: #271a19; }
  .diff-line.removal .diff-marker { color: #dc7b70; }
  .syntax-comment { color: #777d70; font-style: italic; }
  .syntax-string { color: #d4bb78; }
  .syntax-keyword { color: #c69ee5; }
  .syntax-number { color: #80b7d4; }
  @media (max-width: 760px) {
    .agent-app { grid-template-columns: 218px minmax(0, 1fr); }
    .welcome { padding: 24px; }
    .starter-controls { flex-wrap: wrap; }
    .primary { margin-left: 0; }
  }
`;
