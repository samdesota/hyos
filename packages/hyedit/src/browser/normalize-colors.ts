const MODERN_COLOR_FUNCTION = /(?:color-mix|oklab|oklch|lab|lch|color|hwb)\(/i;
const MODERN_COLOR_START = /(?:color-mix|oklab|oklch|lab|lch|color|hwb)\(/gi;

export function replaceModernColorFunctions(
  value: string,
  convert: (color: string) => string,
): string {
  let cursor = 0;
  let output = "";
  MODERN_COLOR_START.lastIndex = 0;

  for (let match = MODERN_COLOR_START.exec(value); match;) {
    const start = match.index;
    const previous = value[start - 1];
    if (previous && /[\w-]/.test(previous)) {
      match = MODERN_COLOR_START.exec(value);
      continue;
    }

    let depth = 0;
    let end = -1;
    for (
      let index = value.indexOf("(", start);
      index < value.length;
      index += 1
    ) {
      if (value[index] === "(") depth += 1;
      if (value[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end === -1) break;

    const color = value.slice(start, end);
    output += value.slice(cursor, start) + convert(color);
    cursor = end;
    MODERN_COLOR_START.lastIndex = end;
    match = MODERN_COLOR_START.exec(value);
  }

  return cursor === 0 ? value : output + value.slice(cursor);
}

export function normalizeClonedDocumentColors(document: Document): void {
  const view = document.defaultView;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!view || !context) return;

  const toSrgb = (color: string): string => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "rgba(0, 0, 0, 0)";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(
      0,
      0,
      1,
      1,
    ).data;
    return alpha === 255
      ? `rgb(${red}, ${green}, ${blue})`
      : `rgba(${red}, ${green}, ${blue}, ${Math.round((alpha / 255) * 1_000) / 1_000})`;
  };

  for (const element of [
    document.documentElement,
    ...document.querySelectorAll<HTMLElement>("*"),
  ]) {
    const computed = view.getComputedStyle(element);
    for (const property of computed) {
      const value = computed.getPropertyValue(property);
      if (!MODERN_COLOR_FUNCTION.test(value)) continue;
      const normalized = replaceModernColorFunctions(value, toSrgb);
      if (normalized !== value) element.style.setProperty(property, normalized);
    }
  }
}
