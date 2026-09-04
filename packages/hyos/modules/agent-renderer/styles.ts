export const agentStyles = String.raw`
  :root {
    color-scheme: dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #eceae5;
    background: #111210;
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
    background: #171816;
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
  .new-session, .primary, .folder-button, .send, .cancel {
    border: 0; border-radius: 9px; cursor: pointer; transition: background .15s, opacity .15s;
  }
  .new-session {
    width: 100%; padding: 10px 12px; text-align: left; background: transparent;
  }
  .new-session:hover { background: #3b3d37; }
  .new-session.open { background: #30312d; }
  .new-session:hover, .folder-button:hover { background: #3b3d37; }
  .session-label {
    padding: 8px 18px; color: #85877e; font-size: 11px; font-weight: 700;
    letter-spacing: .09em; text-transform: uppercase;
  }
  .session-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 18px; }
  .session-row { display: flex; align-items: stretch; border-radius: 9px; }
  .session-open {
    flex: 1; min-width: 0; padding: 10px; border: 0; border-radius: 9px;
    text-align: left; background: transparent; cursor: pointer;
  }
  .session-row:hover { background: #292a27; }
  .session-row.active { background: #34362f; }
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
  .archived-label { padding: 8px 18px 4px; }
  .archived-toggle {
    display: flex; align-items: center; gap: 7px; width: 100%; padding: 0 18px;
    border: 0; background: transparent; cursor: pointer; text-align: left;
  }
  .archived-toggle:hover { color: #b5b7ac; }
  .archived-chevron { font-style: normal; font-size: 16px; }
  .session-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .session-meta { display: flex; gap: 7px; margin-top: 5px; color: #8e9087; font-size: 11px; }
  .status-dot { width: 6px; height: 6px; margin-top: 4px; border-radius: 50%; background: #777; }
  .status-dot.running { background: #d9ff62; box-shadow: 0 0 8px #d9ff6270; }
  .status-dot.failed { background: #ff6f61; }
  .status-dot.cancelled { background: #c5a46d; }
  .agent-main { min-width: 0; min-height: 0; background: #171816; }
  .welcome { display: grid; place-items: center; width: 100%; height: 100%; padding: 38px; overflow-y: auto; }
  .welcome-card { width: min(760px, 100%); }
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
  .conversation.patch-panel-open { grid-template-columns: minmax(0, 1fr) min(var(--patch-panel-width, 520px), calc(100% - 360px)); }
  .conversation-head { display: flex; align-items: center; gap: 12px; padding: 16px 22px; border-bottom: 1px solid #2b2c28; }
  .conversation-title { min-width: 0; }
  .conversation-title strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conversation-title span { color: #898b82; font-size: 12px; }
  .cancel { margin-left: auto; padding: 8px 11px; color: #ffb0a8; background: #3a2826; }
  .patch-toggle {
    margin-left: auto; padding: 7px 10px; border: 1px solid #3a3c35; border-radius: 8px;
    color: #aaaCA2; background: transparent; cursor: pointer;
  }
  .cancel + .patch-toggle { margin-left: 0; }
  .patch-toggle:hover, .patch-toggle.active { color: #e3e2dc; background: #292b26; }
  .patch-toggle span { margin-left: 5px; color: #d9ff62; font-size: 11px; }
  .transcript { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; font-size: 14px; }
  .messages { width: min(820px, calc(100% - 44px)); margin: 0 auto; padding: 34px 0 26px; }
  .loading-older { padding: 8px 0 22px; color: #7f8178; text-align: center; font-size: 12px; }
  .message { margin-bottom: 28px; content-visibility: auto; contain-intrinsic-size: auto 140px; }
  .message.user { padding-left: 12%; }
  .message.user .message-body { padding: 13px 15px; border-radius: 13px; background: #292b26; }
  .message.assistant .message-body { color: #dddcd6; }
  .message.commentary { margin-bottom: 16px; color: #c9c8c1; }
  .message.commentary .message-body { line-height: 1.55; }
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
  .tool-group { margin: -2px 0 20px; color: #8e9087; font-size: 12px; }
  .work-pane { margin: 14px 0 20px; color: #8e9087; font-size: 12px; }
  .work-pane > summary {
    display: flex; align-items: center; gap: 7px; width: fit-content; padding: 4px 0;
    cursor: pointer; list-style: none; user-select: none;
  }
  .work-pane > summary::-webkit-details-marker { display: none; }
  .work-pane > summary:hover { color: #b9bbb1; }
  .work-pane-items { margin: 8px 0 0 9px; padding-left: 14px; border-left: 1px solid #353730; }
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
  .patch-feed {
    position: relative; grid-column: 2; grid-row: 1 / -1; display: flex; flex-direction: column; min-width: 0; min-height: 0;
    border-left: 1px solid #30312d; background: #1d1e1b;
  }
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
  .patch-feed-head {
    display: flex; align-items: center; justify-content: space-between; min-height: 67px; padding: 13px 14px 12px 16px;
    border-bottom: 1px solid #30312d;
  }
  .patch-feed-head strong, .patch-feed-head span { display: block; }
  .patch-feed-head strong { font-size: 13px; }
  .patch-feed-head span { margin-top: 3px; color: #7f8178; font-size: 10px; }
  .patch-feed-head button {
    width: 28px; height: 28px; border: 0; border-radius: 7px; color: #8e9087; background: transparent;
    cursor: pointer; font-size: 20px; line-height: 1;
  }
  .patch-feed-head button:hover { color: #eceae5; background: #30312d; }
  .patch-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; }
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
