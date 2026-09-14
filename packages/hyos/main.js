require("tsx/cjs");

const path = require("node:path");
const { app, ipcMain } = require("electron");

// DevTools/CDP for every HyOS webContents (UI view, browser tab views) —
// must be set before app ready. Opt in with HYOS_DEVTOOLS_PORT=<port>,
// then list targets at http://localhost:<port>/json or chrome://inspect.
const devtoolsPort = Number(process.env.HYOS_DEVTOOLS_PORT ?? "");
if (Number.isInteger(devtoolsPort) && devtoolsPort > 0) {
  app.commandLine.appendSwitch("remote-debugging-port", String(devtoolsPort));
  console.log(`[devtools] CDP listening on http://localhost:${devtoolsPort}`);
}
const { ModuleHost } = require("./runtime");
const { MainApplicationLoader, readManifest } = require("./application-loader");
const { buildRendererArtifacts } = require("./isomorphic-compiler");
const {
  MainRemoteCapabilities,
  remoteChannels,
} = require("./remote-capabilities");

const manifestPath = path.join(__dirname, "application.manifest.ts");
const capabilitiesPath = path.join(__dirname, "capabilities/index.ts");
const projectDirectory = __dirname;
const rendererOutputDirectory = path.join(__dirname, "renderer/generated");
const initialManifest = readManifest(manifestPath);
const bootStartedAt = performance.now();
const BOOT_TRACE = process.env.HYOS_BOOT_TRACE === "1";
const bootTrace = (event, detail = "") => {
  if (!BOOT_TRACE) return;
  console.log(
    `[DEBUG-boot-7f2c] +${Math.round(performance.now() - bootStartedAt)}ms main ${event}${detail ? ` ${detail}` : ""}`,
  );
};
const { applicationCapabilities } = require(capabilitiesPath);
const remoteCapabilities = new MainRemoteCapabilities({
  definitions: applicationCapabilities,
  authorize: assertRenderer,
  broadcast: (message) => sendWhenReady(remoteChannels.event, message),
});
const mainHost = new ModuleHost("main", {
  "application.root": __dirname,
  "remote.capabilities": remoteCapabilities,
  "application.reload": () =>
    enqueueReload(() => reloadChangedFile("capabilities/index.ts")),
});
let loader;
let reloading = false;
let reloadQueue = Promise.resolve();

function rendererContents() {
  const view = mainHost.services.get("electron.ui-view");
  return view && !view.webContents.isDestroyed() ? view.webContents : null;
}

function assertRenderer(event) {
  const contents = rendererContents();
  if (!contents || event.sender !== contents) {
    throw new Error("Unknown renderer");
  }
}

function sendWhenReady(channel, payload) {
  const contents = rendererContents();
  if (!contents) return;
  const send = () => {
    if (!contents.isDestroyed()) contents.send(channel, payload);
  };
  if (contents.isLoadingMainFrame()) {
    contents.once("did-finish-load", send);
  } else {
    send();
  }
}

function publishMainSnapshot(snapshot = mainHost.snapshot()) {
  sendWhenReady("prototype:modules:snapshot", snapshot);
}

function firstHotRendererId() {
  return loader.manifest.modules.find(
    (entry) => entry.host === "renderer" && entry.reload === "hot",
  )?.id;
}

function requestRendererReload(fromId, reason) {
  sendWhenReady("prototype:modules:reload", { fromId, reason });
}

function enqueueReload(operation) {
  reloadQueue = reloadQueue.then(operation, operation);
  return reloadQueue;
}

async function reloadHot(reason) {
  reloading = true;
  try {
    await loader.reloadHot();
    publishMainSnapshot();
    requestRendererReload(firstHotRendererId(), reason);
  } finally {
    reloading = false;
  }
}

async function reloadChangedFile(filename) {
  reloading = true;
  try {
    const changedFile = filename.replaceAll("\\", "/");
    if (changedFile === path.basename(manifestPath)) {
      const manifest = readManifest(manifestPath);
      await buildRendererArtifacts({
        manifest,
        manifestPath,
        capabilitiesPath,
        projectDirectory,
        outputDirectory: rendererOutputDirectory,
      });
      await loader.reloadManifest();
      publishMainSnapshot();
      requestRendererReload(firstHotRendererId(), "manifest changed");
      return;
    }

    loader.refreshManifest();
    const entry = loader.manifest.modules.find((candidate) => {
      const entryFile = candidate.file.replace(/^\.\//, "");
      const entryDirectory = path.posix.dirname(entryFile);
      return (
        entryFile === changedFile ||
        changedFile.startsWith(`${entryDirectory}/`)
      );
    });
    if (!entry) {
      if (changedFile.startsWith("capabilities/")) {
        for (const cachedPath of Object.keys(require.cache)) {
          if (
            cachedPath.startsWith(projectDirectory) &&
            cachedPath.endsWith(".ts")
          ) {
            delete require.cache[cachedPath];
          }
        }
        const nextCapabilities =
          require(capabilitiesPath).applicationCapabilities;
        remoteCapabilities.configure(nextCapabilities);
        loader.refreshManifest();
        await buildRendererArtifacts({
          manifest: loader.manifest,
          manifestPath,
          capabilitiesPath,
          projectDirectory,
          outputDirectory: rendererOutputDirectory,
        });
        await loader.reloadHot();
        publishMainSnapshot();
        requestRendererReload(firstHotRendererId(), `${changedFile} changed`);
      }
      return;
    }

    if (entry.host === "main") {
      await loader.reloadEntry(entry.id);
      publishMainSnapshot();
    } else {
      await buildRendererArtifacts({
        manifest: loader.manifest,
        manifestPath,
        capabilitiesPath,
        projectDirectory,
        outputDirectory: rendererOutputDirectory,
      });
      requestRendererReload(entry.id, `${entry.file} changed`);
    }
  } finally {
    reloading = false;
  }
}

async function runSmokeTest() {
  const contents = rendererContents();
  if (contents.isLoadingMainFrame()) {
    await new Promise((resolve) => contents.once("did-finish-load", resolve));
  }
  const providersBefore = await contents.executeJavaScript(
    'window.hyosRemote.invoke("agent", "providers", [])',
  );
  const sessionsBefore = await contents.executeJavaScript(
    'window.hyosRemote.invoke("agent", "sessions", [])',
  );
  const mainBefore = mainHost.snapshot();
  const rendererBefore = await contents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        const value = document.querySelector("#renderer-state")?.textContent ?? "";
        if (value.includes("agent.renderer")) resolve(value);
        else if (Date.now() > deadline) reject(new Error("renderer modules did not mount"));
        else setTimeout(poll, 20);
      };
      poll();
    })
  `);
  await reloadHot("smoke test");
  const providersAfter = await contents.executeJavaScript(
    'window.hyosRemote.invoke("agent", "providers", [])',
  );
  const mainAfter = mainHost.snapshot();
  const rendererAfter = await contents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const previous = ${JSON.stringify(rendererBefore)};
      const deadline = Date.now() + 3000;
      const poll = () => {
        const value = document.querySelector("#renderer-state")?.textContent ?? "";
        if (value.includes("agent.renderer") && value !== previous) resolve(value);
        else if (Date.now() > deadline) reject(new Error("renderer modules did not reload"));
        else setTimeout(poll, 20);
      };
      poll();
    })
  `);
  const appDisplay = await contents.executeJavaScript(
    'getComputedStyle(document.querySelector("#agent-app")).display',
  );
  if (appDisplay !== "grid") {
    throw new Error(`agent styles did not apply: display=${appDisplay}`);
  }
  const contractRejected = await contents.executeJavaScript(
    'window.hyosRemote.invoke("agent", "not-declared", []).then(() => false, () => true)',
  );
  if (!contractRejected) {
    throw new Error("remote capability accepted an undeclared method");
  }
  const providerIds = providersAfter
    .map(({ id }) => id)
    .sort()
    .join(",");
  if (providerIds !== "claude,codex,glm") {
    throw new Error(`agent providers unavailable: ${providerIds}`);
  }
  const welcomeReady = await contents.executeJavaScript(
    `Boolean(document.querySelector("#agent-start-prompt") && document.querySelector("#agent-session-list") && document.querySelector("#agent-model-picker"))`,
  );
  if (!welcomeReady) throw new Error("agent welcome screen did not render");
  const modelPickerState = await contents.executeJavaScript(
    `(() => {
      const trigger = document.querySelector("#agent-model-picker");
      const height = getComputedStyle(trigger).height;
      trigger.click();
      const menu = document.querySelector('[aria-label="Model settings"]');
      const reasoningOptions = menu?.querySelectorAll(".reasoning-options button").length ?? 0;
      trigger.click();
      return { height, menuVisible: Boolean(menu), reasoningOptions };
    })()`,
  );
  if (
    modelPickerState.height !== "32px" ||
    !modelPickerState.menuVisible ||
    modelPickerState.reasoningOptions !== 4
  ) {
    throw new Error(
      `compact model picker is unavailable: ${JSON.stringify(modelPickerState)}`,
    );
  }
  const uiAgentConnection = await contents.executeJavaScript(
    'window.hyosRemote.invoke("ui-agent", "connection", [])',
  );
  const uiAgentReady = await contents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        const ready = Boolean(
          document.querySelector("#hyedit-launcher") &&
          document.querySelector("#hyedit-overlay")
        );
        if (ready) resolve(true);
        else if (Date.now() > deadline) reject(new Error("hyedit overlay did not mount"));
        else setTimeout(poll, 20);
      };
      poll();
    })
  `);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const visualState = await contents.executeJavaScript(`
    (() => {
      const app = document.querySelector("#agent-app");
      const frame = document.querySelector("#hyedit-overlay");
      const frameStyle = frame ? getComputedStyle(frame) : null;
      return {
        url: location.href,
        appConnected: Boolean(app?.isConnected),
        appDisplay: app ? getComputedStyle(app).display : null,
        appBounds: app ? app.getBoundingClientRect().toJSON() : null,
        frameHidden: frame?.getAttribute("aria-hidden") ?? null,
        frameDisplay: frameStyle?.display ?? null,
        frameVisibility: frameStyle?.visibility ?? null,
        frameBackground: frameStyle?.backgroundColor ?? null,
      };
    })()
  `);
  const rendered = await contents.capturePage();
  const pixels = rendered.toBitmap();
  let whitePixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (
      pixels[index] > 250 &&
      pixels[index + 1] > 250 &&
      pixels[index + 2] > 250
    ) {
      whitePixels += 1;
    }
  }
  const whiteRatio = whitePixels / (pixels.length / 4);
  if (whiteRatio > 0.9) {
    throw new Error(
      `renderer became white: ratio=${whiteRatio.toFixed(3)} state=${JSON.stringify(visualState)}`,
    );
  }
  await contents.executeJavaScript(
    'document.querySelector("#hyedit-launcher").click()',
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const activeFrameState = await contents.executeJavaScript(`
    (() => {
      const frame = document.querySelector("#hyedit-overlay");
      const style = frame ? getComputedStyle(frame) : null;
      return {
        hidden: frame?.getAttribute("aria-hidden") ?? null,
        display: style?.display ?? null,
        visibility: style?.visibility ?? null,
        background: style?.backgroundColor ?? null,
      };
    })()
  `);
  const overlayFrame = contents.mainFrame.frames.find((frame) =>
    frame.url.startsWith(`${uiAgentConnection.serverUrl}/overlay`),
  );
  const embeddedOverlayState = await contents.executeJavaScript(`
    (() => {
      const host = document.querySelector("#hyedit-overlay");
      const shadow = host?.shadowRoot;
      const root = shadow?.querySelector(".hyedit-root");
      const top = shadow?.querySelector(".selection-surface");
      const stylesheet = shadow?.querySelector('link[rel="stylesheet"]');
      const topStyle = top ? getComputedStyle(top) : null;
      if (!shadow) return null;
      return {
        styleSheets: stylesheet?.sheet ? 1 : 0,
        rootBackground: root ? getComputedStyle(root).backgroundColor : null,
        topTag: top?.tagName ?? null,
        topClass: top?.className ?? null,
        topBackground: topStyle?.backgroundColor ?? null,
        topPosition: topStyle?.position ?? null,
        topBounds: top?.getBoundingClientRect().toJSON() ?? null,
      };
    })()
  `);
  const overlayDocumentState =
    embeddedOverlayState ??
    (overlayFrame
      ? await overlayFrame.executeJavaScript(`
        (() => {
          const root = document.querySelector("#root");
          const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
          return {
            styleSheets: document.styleSheets.length,
            htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
            bodyBackground: getComputedStyle(document.body).backgroundColor,
            rootBackground: root ? getComputedStyle(root).backgroundColor : null,
            topTag: top?.tagName ?? null,
            topClass: top?.className ?? null,
            topBackground: top ? getComputedStyle(top).backgroundColor : null,
          };
        })()
      `)
      : null);
  const activeRendered = await contents.capturePage();
  const activePixels = activeRendered.toBitmap();
  let activeWhitePixels = 0;
  for (let index = 0; index < activePixels.length; index += 4) {
    if (
      activePixels[index] > 250 &&
      activePixels[index + 1] > 250 &&
      activePixels[index + 2] > 250
    ) {
      activeWhitePixels += 1;
    }
  }
  const activeWhiteRatio = activeWhitePixels / (activePixels.length / 4);
  if (
    activeFrameState.visibility !== "visible" ||
    !overlayDocumentState?.topClass?.split(" ").includes("selection-surface") ||
    overlayDocumentState.topPosition !== "fixed" ||
    overlayDocumentState.topBounds.width < 1000 ||
    overlayDocumentState.topBounds.height < 700
  ) {
    throw new Error(
      `active UI agent did not enter selection mode: state=${JSON.stringify(activeFrameState)} overlay=${JSON.stringify(overlayDocumentState)}`,
    );
  }
  if (activeWhiteRatio > 0.9) {
    throw new Error(
      `active UI agent became white: ratio=${activeWhiteRatio.toFixed(3)} state=${JSON.stringify(activeFrameState)} overlay=${JSON.stringify(overlayDocumentState)}`,
    );
  }
  const selectionBounds = await contents.executeJavaScript(`
    (async () => {
      const host = document.querySelector("#hyedit-overlay");
      const surface = host?.shadowRoot?.querySelector(".selection-surface");
      if (!surface) return null;
      surface.setPointerCapture = () => {};
      surface.releasePointerCapture = () => {};
      surface.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 120,
        clientY: 120,
        pointerId: 1,
      }));
      await new Promise(requestAnimationFrame);
      surface.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        buttons: 1,
        clientX: 360,
        clientY: 300,
        pointerId: 1,
      }));
      await new Promise(requestAnimationFrame);
      return host.shadowRoot
        .querySelector(".selection-box")
        ?.getBoundingClientRect()
        .toJSON() ?? null;
    })()
  `);
  if (
    !selectionBounds ||
    selectionBounds.width < 200 ||
    selectionBounds.height < 150
  ) {
    throw new Error(
      `Quick edit drag did not create a selection: ${JSON.stringify(selectionBounds)}`,
    );
  }
  await contents.executeJavaScript(`
    (() => {
      const surface = document
        .querySelector("#hyedit-overlay")
        ?.shadowRoot
        ?.querySelector(".selection-surface");
      surface?.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 360,
        clientY: 300,
        pointerId: 1,
      }));
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const promptVisible = await contents.executeJavaScript(`
    Boolean(
      document.querySelector("#hyedit-overlay")
        ?.shadowRoot
        ?.querySelector(".prompt-panel")
    )
  `);
  if (!promptVisible)
    throw new Error("Quick edit drag did not open its prompt");
  const mainReload =
    JSON.stringify(mainBefore) !== JSON.stringify(mainAfter) &&
    providersBefore.length === providersAfter.length;
  console.log(
    `smoke: remoteCapability=agent providers=${providerIds} persistedSessions=${sessionsBefore.sessions.length} welcome=${welcomeReady} uiAgent=${uiAgentReady}@${uiAgentConnection.serverUrl} whiteRatio=${whiteRatio.toFixed(3)} activeWhiteRatio=${activeWhiteRatio.toFixed(3)} activeOverlay=${overlayDocumentState.topClass} drag=${Math.round(selectionBounds.width)}x${Math.round(selectionBounds.height)} prompt=${promptVisible} mainReload=${mainReload} rendererReload=${rendererBefore !== rendererAfter} contractRejected=${contractRejected} appLayout=${appDisplay}`,
  );
  await contents.executeJavaScript(
    'window.dispatchEvent(new Event("beforeunload"))',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  app.quit();
}

async function start() {
  bootTrace("start:entered");
  remoteCapabilities.attach(ipcMain);
  bootTrace("renderer-build:start");
  await buildRendererArtifacts({
    manifest: initialManifest,
    manifestPath,
    capabilitiesPath,
    projectDirectory,
    outputDirectory: rendererOutputDirectory,
  });
  bootTrace("renderer-build:done");
  loader = new MainApplicationLoader({
    host: mainHost,
    manifestPath,
    onChanged: publishMainSnapshot,
  });

  ipcMain.handle("prototype:modules:reload-request", (event) => {
    assertRenderer(event);
    return enqueueReload(() => reloadHot("manual reload"));
  });

  bootTrace("module-loader:start");
  await loader.start();
  bootTrace(
    "module-loader:done",
    JSON.stringify(mainHost.snapshot().modules.map(({ id }) => id)),
  );
  if (process.argv.includes("--smoke-test")) await runSmokeTest();
}

app
  .whenReady()
  .then(() => {
    bootTrace("electron:ready");
    return start();
  })
  .catch((error) => {
    console.error(error);
    app.exitCode = 1;
    app.quit();
  });
app.on("window-all-closed", () => {
  if (!reloading) app.quit();
});
app.on("before-quit", () => {
  ipcMain.removeHandler("prototype:modules:reload-request");
  remoteCapabilities.dispose();
  mainHost.dispose();
});
