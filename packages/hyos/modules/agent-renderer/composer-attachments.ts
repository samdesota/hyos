/**
 * Pure helpers for the composer's image attachments: extracting image files
 * from drag-and-drop and clipboard-paste events, validating them, and
 * converting them to data URLs the renderer can preview (and, in a later
 * step, send with the message).
 */

export type PendingImage = Readonly<{
  id: string;
  /** The image bytes as a `data:` URL, ready for preview and transport. */
  dataUrl: string;
  name: string;
  mimeType: string;
}>;

/** Attachments larger than this are rejected (screenshots are far smaller). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Upper bound on simultaneously pending attachments per composer. */
export const MAX_PENDING_IMAGES = 8;

const IMAGE_MIME_PREFIX = "image/";

/** True when the file is an image we can preview and send, within the size cap. */
export function isSupportedImage(file: {
  type: string;
  size: number;
}): boolean {
  return (
    file.type.startsWith(IMAGE_MIME_PREFIX) &&
    file.type !== "image/svg+xml" &&
    file.size > 0 &&
    file.size <= MAX_IMAGE_BYTES
  );
}

/** Base64-encode bytes without Node's Buffer (this code runs in the renderer). */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Convert one validated image file into a pending attachment, or null. */
export async function fileToPendingImage(
  file: File,
): Promise<PendingImage | null> {
  if (!isSupportedImage(file)) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    id: crypto.randomUUID(),
    dataUrl: `data:${file.type};base64,${base64FromBytes(bytes)}`,
    name: file.name || "image",
    mimeType: file.type,
  };
}

/** Extract and convert every supported image from an indexed file collection. */
export async function pendingImagesFromFiles(
  files: ArrayLike<File>,
): Promise<readonly PendingImage[]> {
  const images: PendingImage[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const image = await fileToPendingImage(files[index]);
    if (image) images.push(image);
  }
  return images;
}

/**
 * Images dropped on the composer. Reads `dataTransfer.files`, which is the
 * reliable cross-platform list for file drops (including screenshots).
 */
export async function pendingImagesFromDataTransfer(
  transfer: DataTransfer | null,
): Promise<readonly PendingImage[]> {
  if (!transfer) return [];
  return pendingImagesFromFiles(transfer.files);
}

/**
 * Images pasted into the composer. Clipboard image data surfaces through
 * `DataTransferItemList` items rather than `files` on some platforms, so
 * both are consulted.
 */
export async function pendingImagesFromPaste(
  transfer: DataTransfer | null,
): Promise<readonly PendingImage[]> {
  if (!transfer) return [];
  const fromFiles = await pendingImagesFromFiles(transfer.files);
  if (fromFiles.length > 0) return fromFiles;
  const files: File[] = [];
  for (let index = 0; index < transfer.items.length; index += 1) {
    const item = transfer.items[index];
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return pendingImagesFromFiles(files);
}
