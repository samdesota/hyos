/**
 * Short (3–5 word) sidebar descriptions of what a session is working on.
 * Derived deterministically — no extra model call — from the user's latest
 * prompt, falling back to the previous assistant response's closing prose
 * when the prompt is a bare continuation like "continue" or "go ahead".
 */

const CONTINUATION_PROMPT =
  /^(?:resume|continue|keep going|go on|pick (?:it|this) back up|go ahead|proceed|next|do it|yes|yeah|ok(?:ay)?|sounds good|lgtm|ship it)\b/i;

const MAX_WORDS = 5;
const MAX_CHARS = 48;

/** Plain-prose lines with code fences, plan blocks, and markdown noise removed. */
function proseLines(text: string): string[] {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*[#>*\-+]+\s*/, "")
        .replace(/^\s*\d+[.)]\s*/, "")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/[*_]+([^*_]+)[*_]+/g, "$1")
        .trim(),
    )
    .filter((line) => line.length > 0 && !line.startsWith("|"));
}

function phraseFrom(
  lines: readonly string[],
  pick: "first" | "last",
): string | null {
  const line = pick === "first" ? lines[0] : lines[lines.length - 1];
  if (!line) return null;
  const clause = line.split(/[.;!?]/, 1)[0] ?? line;
  const words = clause
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, MAX_WORDS)
    .join(" ");
  const trimmed = words.replace(/[,:;)\]]+$/, "").trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_CHARS
    ? `${trimmed.slice(0, MAX_CHARS - 1).trimEnd()}…`
    : trimmed;
}

/**
 * Describe the work a starting turn will do. Prefers a substantive prompt;
 * continuation prompts ("continue", "go ahead") describe the previous
 * response's final prose instead. Returns null when nothing usable exists.
 */
export function describeWork(
  prompt: string,
  previousResponse: string | null,
): string | null {
  const promptPhrase = phraseFrom(proseLines(prompt), "first");
  if (promptPhrase && !CONTINUATION_PROMPT.test(promptPhrase))
    return promptPhrase;
  const previous = previousResponse ? proseLines(previousResponse) : [];
  return phraseFrom(previous, "last") ?? promptPhrase;
}
