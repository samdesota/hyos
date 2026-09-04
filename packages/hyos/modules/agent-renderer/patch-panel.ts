type ResizeElement = Readonly<{
  clientWidth: number;
}>;

type ResizeHandle = Readonly<{
  closest(selector: string): ResizeElement | null;
}>;

export function resizedPatchPanelWidth(input: {
  divider: ResizeHandle;
  fallbackWidth: number;
  startWidth: number;
  startX: number;
  currentX: number;
}): number {
  const conversationWidth =
    input.divider.closest(".conversation")?.clientWidth ?? input.fallbackWidth;
  const available = Math.max(360, conversationWidth - 360);
  return Math.min(
    Math.max(360, input.startWidth + input.startX - input.currentX),
    available,
  );
}
