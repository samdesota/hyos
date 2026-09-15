import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * One composer image persisted to disk: `file` is the bare file name inside
 * the media directory; the database references it by `id`, never the bytes.
 */
export type StoredImage = Readonly<{
  id: string;
  file: string;
  mimeType: string;
}>;

const dataUrlPattern =
  /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

const extensionsByMimeType = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
]);

/** Decode a `data:<mime>;base64,…` URL. Null when malformed or not base64. */
export function decodeImageDataUrl(
  dataUrl: string,
): { bytes: Buffer; mimeType: string } | null {
  const match = dataUrlPattern.exec(dataUrl.trim());
  if (!match) return null;
  const mimeType = match[1] ?? "";
  const base64 = match[2] ?? "";
  if (!extensionsByMimeType.has(mimeType) || base64.length === 0) return null;
  try {
    const bytes = Buffer.from(base64.replace(/\s/g, ""), "base64");
    return bytes.length > 0 ? { bytes, mimeType } : null;
  } catch {
    return null;
  }
}

export interface MediaStore {
  /**
   * Persist composer data URLs as files, returning one StoredImage per valid
   * image. Invalid entries are skipped rather than failing the whole turn.
   */
  saveImages(dataUrls: readonly string[]): Promise<StoredImage[]>;
  /** Absolute path of a stored file name inside the media directory. */
  pathFor(file: string): string;
}

export function createMediaStore({
  directory,
}: Readonly<{ directory: string }>): MediaStore {
  return {
    async saveImages(dataUrls) {
      const decoded = dataUrls
        .map(decodeImageDataUrl)
        .filter((image): image is { bytes: Buffer; mimeType: string } =>
          Boolean(image),
        );
      if (decoded.length === 0) return [];
      await mkdir(directory, { recursive: true });
      return Promise.all(
        decoded.map(async ({ bytes, mimeType }) => {
          const id = randomUUID();
          const file = `${id}${extensionsByMimeType.get(mimeType)}`;
          await writeFile(path.join(directory, file), bytes);
          return { id, file, mimeType };
        }),
      );
    },
    pathFor: (file) => path.join(directory, path.basename(file)),
  };
}
