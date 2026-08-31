import { micromark } from "micromark";

export function renderAgentMarkdown(markdown: string): string {
  return micromark(markdown);
}
