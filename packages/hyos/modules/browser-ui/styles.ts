export const browserUiStyles = `
  :root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color:#292620; }
  * { box-sizing:border-box; }
  html, body, #app { width:100%; height:100%; margin:0; overflow:hidden; background:transparent; }
  button, input { font:inherit; }
  button { border:1px solid #cec7bb; background:#fff; border-radius:7px; color:#4c453c; cursor:pointer; }
  button:disabled { opacity:.38; cursor:default; }
  .browser-app { width:100%; height:100%; display:grid; grid-template-rows:auto minmax(0, 1fr) auto; background:transparent; }
  .browser-chrome { padding:12px 16px 10px; background:rgba(248,246,241,.98); border-bottom:1px solid #c8c1b6; box-shadow:0 2px 10px rgb(56 47 34 / 10%); }
  .topline { height:28px; display:flex; align-items:center; gap:12px; min-width:0; }
  .topline strong { white-space:nowrap; }
  .traffic { display:flex; gap:7px; }
  .traffic i { width:10px; height:10px; border-radius:50%; background:#dd6857; }
  .traffic i:nth-child(2) { background:#dda743; }
  .traffic i:nth-child(3) { background:#70ae78; }
  .browser-tabs-shell { display:flex; align-items:center; gap:4px; flex:1; min-width:100px; overflow:hidden; }
  .browser-tabs { display:flex; gap:3px; min-width:0; overflow-x:auto; scrollbar-width:none; }
  .browser-tab { display:flex; align-items:center; height:24px; min-width:105px; max-width:180px; border:1px solid #c7c0b5; border-radius:7px; background:#e7e1d8; overflow:hidden; }
  .browser-tab.active { background:#fff; border-color:#8b6d45; box-shadow:0 1px 3px rgb(43 38 30 / 12%); }
  .browser-tab-select { height:22px; min-width:0; flex:1; padding:0 4px 0 8px; border:0; background:transparent; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; font-size:11px; }
  .browser-tab-close { height:20px; min-width:22px; padding:0; border:0; background:transparent; font-size:14px; }
  .browser-new-tab { height:24px; min-width:26px; padding:0; font-size:16px; }
  .protocol { color:#6c645a; font-size:11px; white-space:nowrap; }
  .toolbar { display:flex; gap:8px; margin-top:9px; }
  .toolbar button { width:42px; height:34px; }
  .toolbar input { flex:1; min-width:80px; height:34px; padding:0 12px; border:1px solid #c8c1b6; border-radius:8px; background:white; font-size:16px; }
  .toolbar .go { width:54px; background:#80613d; border-color:#80613d; color:white; font-weight:700; }
  .browser-stage { position:relative; min-width:0; min-height:0; background:transparent; }
  .active-browser-view { position:absolute; inset:14px 18px 12px; background:transparent; }
  .renderer-overlay { position:absolute; top:28px; right:32px; z-index:5; padding:8px 11px; border:1px solid rgb(255 255 255 / 65%); border-radius:999px; background:rgb(32 31 28 / 82%); color:white; box-shadow:0 4px 16px rgb(0 0 0 / 20%); font-size:11px; pointer-events:auto; }
  .diagnostics { display:flex; justify-content:space-between; align-items:center; min-height:42px; padding:8px 16px; background:rgba(248,246,241,.98); border-top:1px solid #c8c1b6; color:#625b51; font-size:12px; }
  .diagnostics details { text-align:right; }
  .diagnostics code { display:inline-block; max-width:580px; overflow:hidden; text-overflow:ellipsis; vertical-align:bottom; white-space:nowrap; }
`;
