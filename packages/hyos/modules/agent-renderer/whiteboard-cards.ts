/**
 * Card model for the whiteboard: markdown notes placed at world
 * coordinates, so they pan and zoom with the canvas. Cards are pure data
 * — the page owns the list, and persistence comes later via the agent
 * capability.
 */
export type WhiteboardCard = Readonly<{
  id: string;
  /** World coordinates of the card's top-left corner. */
  x: number;
  y: number;
  markdown: string;
}>;

/** Add a card at a world point; the caller supplies the fresh id. */
export function addWhiteboardCard(
  cards: readonly WhiteboardCard[],
  card: WhiteboardCard,
): readonly WhiteboardCard[] {
  return [...cards, card];
}

/** Replace one card's markdown, leaving the rest untouched. */
export function updateWhiteboardCard(
  cards: readonly WhiteboardCard[],
  id: string,
  markdown: string,
): readonly WhiteboardCard[] {
  const matching = cards.some((card) => card.id === id);
  if (!matching) return cards;
  return cards.map((card) => (card.id === id ? { ...card, markdown } : card));
}

/** Move one card to new world coordinates, leaving the rest untouched. */
export function moveWhiteboardCard(
  cards: readonly WhiteboardCard[],
  id: string,
  x: number,
  y: number,
): readonly WhiteboardCard[] {
  const matching = cards.some((card) => card.id === id);
  if (!matching) return cards;
  return cards.map((card) => (card.id === id ? { ...card, x, y } : card));
}

/** Drop a card (used when an edit commits as empty). */
export function removeWhiteboardCard(
  cards: readonly WhiteboardCard[],
  id: string,
): readonly WhiteboardCard[] {
  return cards.filter((card) => card.id !== id);
}

/** A committed edit that is only whitespace deletes the card. */
export function isBlankCardMarkdown(markdown: string): boolean {
  return markdown.trim().length === 0;
}
