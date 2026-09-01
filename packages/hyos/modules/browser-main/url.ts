export function normalizeUrl(input: string | undefined): string {
  const candidate = input?.trim();
  if (!candidate) throw new Error("Enter a URL");
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(candidate)
    ? candidate
    : `https://${candidate}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }
  return url.toString();
}
