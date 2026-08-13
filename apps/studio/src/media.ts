/**
 * Uploads.
 *
 * An uploaded image is committed in the same commit as the content that points
 * at it. That is the whole reason the Git layer builds trees by hand: if the
 * picture and the JSON referencing it landed separately, every deploy between
 * the two would build a page with a broken image.
 *
 * Dimensions are read from the file's own header rather than trusted from the
 * browser or left blank. `width` and `height` in the stored value are what stop
 * a page reflowing as images load, so they are worth ~100 lines of byte
 * fiddling and no dependency at all.
 */

import { createHash } from "node:crypto";
import { mediaFilePath, mediaUrl, slugify, type CmsConfig } from "@greatcms/spec";

/**
 * Formats a browser will render inline, and that carry their size in a header
 * we can read. SVG is deliberately absent: it is a script-bearing document, and
 * an editor uploading one to a site is a stored-XSS vector on that site.
 */
export const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export const MAX_BYTES = 8 * 1024 * 1024;

export interface UploadInput {
  /** Original file name from the browser, used only to derive a readable slug. */
  fileName: string;
  type: string;
  bytes: Uint8Array;
}

export interface UploadResult {
  /** Repo-relative path the bytes are committed to. */
  path: string;
  /** Public URL the site will serve it from. */
  src: string;
  width?: number;
  height?: number;
  base64: string;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(fix ? `${message}\n  fix: ${fix}` : message);
    this.name = "UploadError";
  }
}

export function prepareUpload(config: CmsConfig, input: UploadInput): UploadResult {
  const extension = ALLOWED_TYPES[input.type];
  if (!extension) {
    throw new UploadError(
      `${input.fileName} is a ${input.type || "unknown"} file, which cannot be uploaded.`,
      `Use one of: ${Object.keys(ALLOWED_TYPES).join(", ")}.`,
    );
  }
  if (input.bytes.byteLength === 0) {
    throw new UploadError(`${input.fileName} is empty.`);
  }
  if (input.bytes.byteLength > MAX_BYTES) {
    throw new UploadError(
      `${input.fileName} is ${formatBytes(input.bytes.byteLength)}, over the ${formatBytes(MAX_BYTES)} limit.`,
      "Resize or compress it before uploading.",
    );
  }

  // Content-addressed suffix: re-uploading identical bytes reuses the same
  // path (so no duplicate blobs), while an edited image gets a new URL and
  // therefore busts any cache holding the old one.
  const digest = createHash("sha256").update(input.bytes).digest("hex").slice(0, 8);
  const base = slugify(input.fileName.replace(/\.[^.]+$/, "")) || "upload";
  const fileName = `${base}-${digest}.${extension}`;

  const size = imageSize(input.bytes);

  return {
    path: mediaFilePath(config, fileName),
    src: mediaUrl(config, fileName),
    ...size,
    base64: Buffer.from(input.bytes).toString("base64"),
  };
}

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Reads intrinsic size from the file header. Returns null rather than guessing
 * when a format is unrecognised — a wrong width is worse than none, because the
 * page would reserve the wrong space.
 */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 8-byte signature, then an IHDR chunk whose payload starts with the
  // dimensions as big-endian 32-bit integers.
  if (bytes.byteLength > 24 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // GIF: little-endian 16-bit dimensions at a fixed offset.
  if (bytes.byteLength > 10 && startsWith(bytes, [0x47, 0x49, 0x46])) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  if (bytes.byteLength > 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return webpSize(bytes, view);
  }

  if (bytes.byteLength > 4 && startsWith(bytes, [0xff, 0xd8])) {
    return jpegSize(bytes, view);
  }

  return null;
}

function webpSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  const format = ascii(bytes, 12, 4);

  if (format === "VP8X") {
    // Canvas size is stored minus one, across three bytes each.
    const width = 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16));
    const height = 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16));
    return { width, height };
  }
  if (format === "VP8 ") {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (format === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

/** Walks JPEG segments to the start-of-frame marker, which carries the size. */
function jpegSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  let offset = 2;

  while (offset + 9 < bytes.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = view.getUint8(offset + 1);

    // SOF0–SOF15, excluding the DHT/JPG/DAC markers that share the range.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isStartOfFrame) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }

    const length = view.getUint16(offset + 2);
    if (length < 2) return null; // malformed; stop rather than loop forever
    offset += 2 + length;
  }
  return null;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
