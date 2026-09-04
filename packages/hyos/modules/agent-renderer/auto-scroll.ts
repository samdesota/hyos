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
  return {
    reset() {
      following = true;
    },
    observeScroll(container: ScrollContainer) {
      following = distanceFromBottom(container) <= threshold;
    },
    shouldFollow(_container: ScrollContainer): boolean {
      return following;
    },
  };
}
