export type ScrollContainer = Readonly<{
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}>;

function distanceFromBottom(container: ScrollContainer): number {
  return container.scrollHeight - container.scrollTop - container.clientHeight;
}

export function createAutoScrollController(threshold = 100) {
  let following = true;
  let pinnedAt = -Infinity;
  return {
    reset() {
      following = true;
      pinnedAt = -Infinity;
    },
    // Called right before programmatically assigning scrollTop. Content
    // appended by streaming can push the view far from the bottom for a
    // frame or two, and the resulting scroll events must not be mistaken
    // for the user scrolling away.
    pin() {
      following = true;
      pinnedAt = performance.now();
    },
    observeScroll(container: ScrollContainer) {
      if (performance.now() - pinnedAt < 100) return;
      following = distanceFromBottom(container) <= threshold;
    },
    shouldFollow(_container: ScrollContainer): boolean {
      return following;
    },
  };
}
