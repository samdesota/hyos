require("tsx/cjs");

const fs = require("node:fs");
const path = require("node:path");
const { app, ipcMain } = require("electron");
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
const { applicationCapabilities } = require(capabilitiesPath);
const remoteCapabilities = new MainRemoteCapabilities({
  definitions: applicationCapabilities,
  authorize: assertRenderer,
  broadcast: (message) => sendWhenReady(remoteChannels.event, message),
});
const mainHost = new ModuleHost("main", {
  "application.root": __dirname,
  "remote.capabilities": remoteCapabilities,
});
let loader;
let watcher;
let reloading = false;
let reloadQueue = Promise.resolve();
let watchTimer;

function currentWindow() {
  return mainHost.services.get("electron.overlay-window");
}

function assertRenderer(event) {
  const window = currentWindow();
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error("Unknown renderer");
  }
}

function sendWhenReady(channel, payload) {
  const window = currentWindow();
  if (!window || window.isDestroyed()) return;
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };
  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once("did-finish-load", send);
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

function watchModules() {
  watcher = fs.watch(
    projectDirectory,
    { recursive: true },
    (_event, filename) => {
      if (!filename) return;
      if (
        filename.startsWith("renderer/generated/") ||
        filename.includes("node_modules/")
      ) {
        return;
      }
      clearTimeout(watchTimer);
      watchTimer = setTimeout(
        () => enqueueReload(() => reloadChangedFile(filename)),
        80,
      );
    },
  );
}

async function runSmokeTest() {
  const window = currentWindow();
  if (window.webContents.isLoadingMainFrame()) {
    await new Promise((resolve) =>
      window.webContents.once("did-finish-load", resolve),
    );
  }
  const before = await window.webContents.executeJavaScript(
    'window.hyosRemote.invoke("browser", "execute", [{ type: "snapshot" }])',
  );
  const rendererBefore = await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        const value = document.querySelector("#renderer-state")?.textContent ?? "";
        if (value.includes("browser.renderer")) resolve(value);
        else if (Date.now() > deadline) reject(new Error("renderer modules did not mount"));
        else setTimeout(poll, 20);
      };
      poll();
    })
  `);
  await reloadHot("smoke test");
  const after = await window.webContents.executeJavaScript(
    'window.hyosRemote.invoke("browser", "execute", [{ type: "snapshot" }])',
  );
  const rendererAfter = await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const previous = ${JSON.stringify(rendererBefore)};
      const deadline = Date.now() + 3000;
      const poll = () => {
        const value = document.querySelector("#renderer-state")?.textContent ?? "";
        if (value.includes("browser.renderer") && value !== previous) resolve(value);
        else if (Date.now() > deadline) reject(new Error("renderer modules did not reload"));
        else setTimeout(poll, 20);
      };
      poll();
    })
  `);
  const tabDisplay = await window.webContents.executeJavaScript(
    'getComputedStyle(document.querySelector(".browser-tabs-shell")).display',
  );
  if (tabDisplay !== "flex") {
    throw new Error(`tab styles did not apply: display=${tabDisplay}`);
  }
  const contractRejected = await window.webContents.executeJavaScript(
    'window.hyosRemote.invoke("browser", "not-declared", []).then(() => false, () => true)',
  );
  if (!contractRejected) {
    throw new Error("remote capability accepted an undeclared method");
  }
  const baseWindow = mainHost.services.get("electron.base-window");
  const overlayStacked =
    window.getParentWindow() === baseWindow &&
    baseWindow.contentView.children.length > 0;
  if (!overlayStacked) {
    throw new Error("browser view was not stacked behind the renderer window");
  }
  const rendererLayout = await window.webContents.executeJavaScript(`(() => {
    const surface = document.querySelector(".active-browser-view").getBoundingClientRect();
    const overlay = document.querySelector(".renderer-overlay").getBoundingClientRect();
    return {
      surface: { x: surface.x, y: surface.y, width: surface.width, height: surface.height },
      overlayIntersects:
        overlay.left < surface.right && overlay.right > surface.left &&
        overlay.top < surface.bottom && overlay.bottom > surface.top,
    };
  })()`);
  const nativeBounds = baseWindow.contentView.children[0].getBounds();
  const boundsSynchronized = ["x", "y", "width", "height"].every(
    (key) => Math.abs(nativeBounds[key] - rendererLayout.surface[key]) <= 1,
  );
  if (!boundsSynchronized || !rendererLayout.overlayIntersects) {
    throw new Error(
      "Solid BrowserView did not synchronize its composited layout",
    );
  }
  console.log(
    `smoke: remoteCapability=browser overlayStacked=${overlayStacked} boundsSynchronized=${boundsSynchronized} rendererOverlay=${rendererLayout.overlayIntersects} mainReload=${before.generation !== after.generation} rendererReload=${rendererBefore !== rendererAfter} contractRejected=${contractRejected} tabLayout=${tabDisplay}`,
  );
  await window.webContents.executeJavaScript(
    'window.dispatchEvent(new Event("beforeunload"))',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  app.quit();
}

async function start() {
  remoteCapabilities.attach(ipcMain);
  await buildRendererArtifacts({
    manifest: initialManifest,
    manifestPath,
    capabilitiesPath,
    projectDirectory,
    outputDirectory: rendererOutputDirectory,
  });
  loader = new MainApplicationLoader({
    host: mainHost,
    manifestPath,
    onChanged: publishMainSnapshot,
  });

  ipcMain.handle("prototype:modules:reload-request", (event) => {
    assertRenderer(event);
    return enqueueReload(() => reloadHot("manual reload"));
  });

  await loader.start();
  watchModules();
  if (process.argv.includes("--smoke-test")) await runSmokeTest();
}

app.whenReady().then(start);
app.on("window-all-closed", () => {
  if (!reloading) app.quit();
});
app.on("before-quit", () => {
  clearTimeout(watchTimer);
  watcher?.close();
  ipcMain.removeHandler("prototype:modules:reload-request");
  remoteCapabilities.dispose();
  mainHost.dispose();
});
