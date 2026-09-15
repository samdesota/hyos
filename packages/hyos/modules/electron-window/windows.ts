import path from "node:path";
import { BrowserWindow, WebContentsView, type WebPreferences } from "electron";
import { remoteChannels } from "../../remote-capabilities.js";

export type ElectronWindowConfig = Readonly<{
  title: string;
  width: number;
  height: number;
}>;

export type ElectronWindows = Readonly<{
  baseWindow: BrowserWindow;
  uiView: WebContentsView;
  alignUi(): void;
}>;

/**
 * Single-window shell: the app UI renders in its own `WebContentsView`
 * layered inside the base window. Browser tab views are appended to the
 * same `contentView` afterwards, so they composite above the UI; a modal
 * overlay mode can re-raise the UI view when UI must cover browser content.
 */
export function createElectronWindows(
  root: string,
  config: ElectronWindowConfig,
): ElectronWindows {
  const showWindow = !process.argv.includes("--smoke-test");
  const webPreferences: WebPreferences = {
    preload: path.join(root, "preload.js"),
    additionalArguments: [
      `--remote-invoke-channel=${remoteChannels.invoke}`,
      `--remote-event-channel=${remoteChannels.event}`,
    ],
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
  const baseWindow = new BrowserWindow({
    width: config.width,
    height: config.height,
    minWidth: 720,
    minHeight: 520,
    // Frameless with native traffic lights; they draw over the sidebar's
    // top-left corner, where the brand mark used to sit.
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 22 },
    title: config.title,
    // Theme-colored (not cream) so regions where the transparent UI shows
    // through to the window still read as the app background.
    backgroundColor: "#171816",
    show: false,
  });
  const uiView = new WebContentsView({ webPreferences });
  // Append (no index) so the UI sits above the window's own blank contents
  // and below browser views that browser.main attaches later.
  baseWindow.contentView.addChildView(uiView);
  // Transparent view background so the UI composites over browser views
  // beneath it (modal overlay mode) instead of painting an opaque page.
  uiView.setBackgroundColor("#00000000");
  const alignUi = (): void => {
    if (baseWindow.isDestroyed() || uiView.webContents.isDestroyed()) return;
    const [width, height] = baseWindow.getContentSize();
    uiView.setBounds({ x: 0, y: 0, width, height });
  };
  alignUi();

  const bootTrace = (message: string) => {
    if (process.env.HYOS_BOOT_TRACE === "1")
      console.log(`[DEBUG-boot-7f2c] renderer ${message}`);
  };
  uiView.webContents.on("did-start-loading", () =>
    bootTrace("navigation:start"),
  );
  uiView.webContents.on("did-finish-load", () => bootTrace("navigation:done"));
  uiView.webContents.on("render-process-gone", (_event, details) =>
    bootTrace(`process:gone ${details.reason} exit=${details.exitCode}`),
  );
  void uiView.webContents.loadFile(path.join(root, "renderer/index.html"));
  if (showWindow) {
    // The base window itself loads nothing, so gate the reveal on the UI
    // view's contents having finished their first load.
    uiView.webContents.once("did-finish-load", () => {
      alignUi();
      baseWindow.show();
    });
  }
  return { baseWindow, uiView, alignUi };
}
