import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_BYTES,
  fileToPendingImage,
  isSupportedImage,
  pendingImagesFromDataTransfer,
  pendingImagesFromFiles,
  pendingImagesFromPaste,
} from "./composer-attachments.js";

const pngFile = (size = 4): File =>
  new File([new Uint8Array(size)], "shot.png", { type: "image/png" });

test("isSupportedImage accepts common raster images within the size cap", () => {
  assert.equal(isSupportedImage({ type: "image/png", size: 4 }), true);
  assert.equal(isSupportedImage({ type: "image/jpeg", size: 4 }), true);
  assert.equal(isSupportedImage({ type: "image/webp", size: 4 }), true);
  assert.equal(
    isSupportedImage({ type: "image/png", size: MAX_IMAGE_BYTES }),
    true,
  );
});

test("isSupportedImage rejects non-images, empty, oversized, and svg files", () => {
  assert.equal(isSupportedImage({ type: "text/plain", size: 4 }), false);
  assert.equal(isSupportedImage({ type: "image/png", size: 0 }), false);
  assert.equal(
    isSupportedImage({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }),
    false,
  );
  assert.equal(isSupportedImage({ type: "image/svg+xml", size: 4 }), false);
  assert.equal(isSupportedImage({ type: "", size: 4 }), false);
});

test("fileToPendingImage converts an image file to a data URL attachment", async () => {
  const image = await fileToPendingImage(pngFile());
  assert.ok(image);
  assert.equal(image.name, "shot.png");
  assert.equal(image.mimeType, "image/png");
  assert.ok(image.id.length > 0);
  // Empty file (4 zero bytes) base64-encodes to "AAAAAA==".
  assert.equal(image.dataUrl, "data:image/png;base64,AAAAAA==");
});

test("fileToPendingImage returns null for unsupported files", async () => {
  assert.equal(
    await fileToPendingImage(
      new File(["hi"], "note.txt", { type: "text/plain" }),
    ),
    null,
  );
  assert.equal(await fileToPendingImage(pngFile(0)), null);
});

test("pendingImagesFromFiles keeps only supported images", async () => {
  const images = await pendingImagesFromFiles([
    pngFile(),
    new File(["x"], "readme.md", { type: "text/markdown" }),
  ]);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.mimeType, "image/png");
});

test("pendingImagesFromDataTransfer reads dropped files and ignores null", async () => {
  assert.deepEqual(await pendingImagesFromDataTransfer(null), []);
  const transfer = { files: [pngFile()] } as unknown as DataTransfer;
  const images = await pendingImagesFromDataTransfer(transfer);
  assert.equal(images.length, 1);
});

test("pendingImagesFromPaste falls back to clipboard items when files are empty", async () => {
  const file = pngFile();
  const items = [
    { kind: "file", getAsFile: () => file },
    { kind: "string", getAsFile: () => null },
  ] as unknown as DataTransferItemList;
  const emptyFiles = { length: 0, [Symbol.iterator]: [][Symbol.iterator] };
  const transfer = {
    files: emptyFiles as unknown as FileList,
    items,
  } as unknown as DataTransfer;
  const images = await pendingImagesFromPaste(transfer);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.name, "shot.png");
});
