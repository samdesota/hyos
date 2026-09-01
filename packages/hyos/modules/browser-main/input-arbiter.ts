import { screen, type BrowserWindow } from "electron";
import type { BrowserBounds } from "../../capabilities/browser.js";

function containsPoint(
  point: Readonly<{ x: number; y: number }>,
  bounds: BrowserBounds,
): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

export class BrowserInputArbiter {
  private overlayRegions: readonly BrowserBounds[] = [];
  private passingThrough = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly overlayWindow: BrowserWindow,
    private readonly browserRegions: () => readonly BrowserBounds[],
  ) {
    this.timer = setInterval(() => this.sync(), 24);
  }

  setOverlayRegions(regions: readonly BrowserBounds[]): void {
    this.overlayRegions = regions;
    this.sync();
  }

  sync(): void {
    if (this.overlayWindow.isDestroyed()) return;
    const windowBounds = this.overlayWindow.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const local = {
      x: cursor.x - windowBounds.x,
      y: cursor.y - windowBounds.y,
    };
    const overBrowser = this.browserRegions().some((bounds) =>
      containsPoint(local, bounds),
    );
    const overOverlay = this.overlayRegions.some((bounds) =>
      containsPoint(local, bounds),
    );
    this.setPassThrough(overBrowser && !overOverlay);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.setPassThrough(false);
  }

  private setPassThrough(next: boolean): void {
    if (this.overlayWindow.isDestroyed() || next === this.passingThrough) {
      return;
    }
    this.passingThrough = next;
    this.overlayWindow.setIgnoreMouseEvents(next, { forward: true });
  }
}
