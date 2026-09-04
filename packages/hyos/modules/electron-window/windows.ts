import path from "node:path";
import { BrowserWindow, type WebPreferences } from "electron";
import { remoteChannels } from "../../remote-capabilities.js";

export type ElectronWindowConfig = Readonly<{
  title: string;
  width: number;
  height: number;
  rendererSurface?: "base" | "overlay";
}>;

export type ElectronWindows = Readonly<{
  baseWindow: BrowserWindow;
  overlayWindow: BrowserWindow;
  alignOverlay(): void;
}>;

export function createElectronWindows(
  root: string,
  config: ElectronWindowConfig,
): ElectronWindows {
  const rendererSurface = config.rendererSurface ?? "overlay";
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
    frame: false,
    title: config.title,
    backgroundColor: "#f5f2ec",
    show: false,
    ...(rendererSurface === "base" ? { webPreferences } : {}),
  });
  if (rendererSurface === "base") {
    const alignOverlay = (): void => {};
    void baseWindow.loadFile(path.join(root, "renderer/index.html"));
    if (showWindow) baseWindow.once("ready-to-show", () => baseWindow.show());
    return { baseWindow, overlayWindow: baseWindow, alignOverlay };
  }
  const overlayWindow = new BrowserWindow({
    ...baseWindow.getContentBounds(),
    parent: baseWindow,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    webPreferences,
  });
  const alignOverlay = (): void => {
    if (baseWindow.isDestroyed() || overlayWindow.isDestroyed()) return;
    overlayWindow.setBounds(baseWindow.getContentBounds());
  };

  void baseWindow.loadFile(path.join(root, "renderer/base.html"));
  if (showWindow) baseWindow.once("ready-to-show", () => baseWindow.show());
  void overlayWindow.loadFile(path.join(root, "renderer/index.html"));
  if (showWindow)
    overlayWindow.once("ready-to-show", () => {
      alignOverlay();
      overlayWindow.show();
    });
  return { baseWindow, overlayWindow, alignOverlay };
}
