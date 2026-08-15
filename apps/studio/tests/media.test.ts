/** Uploads, including the header parsing that recovers width and height without a dependency. */

import { DEFAULT_CONFIG } from "@greatcms/spec";
import { describe, expect, it } from "vitest";
import { imageSize, MAX_BYTES, prepareUpload, UploadError } from "../src/media.js";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(14);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, a JFIF APP0 segment to skip over, then SOF0 carrying the size.
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xe0], 2);
  view.setUint16(4, 16); // APP0 length
  bytes.set([0xff, 0xc0], 20); // SOF0
  view.setUint16(22, 17);
  bytes[24] = 8; // precision
  view.setUint16(25, height);
  view.setUint16(27, width);
  return bytes;
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode("RIFF"), 0);
  bytes.set(encoder.encode("WEBP"), 8);
  bytes.set(encoder.encode("VP8X"), 12);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return bytes;
}

describe("reading dimensions from the file itself", () => {
  it("reads PNG", () => {
    expect(imageSize(png(1200, 800))).toEqual({ width: 1200, height: 800 });
  });

  it("reads GIF", () => {
    expect(imageSize(gif(320, 240))).toEqual({ width: 320, height: 240 });
  });

  it("reads JPEG, skipping the segments before the frame header", () => {
    expect(imageSize(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("reads WebP", () => {
    expect(imageSize(webpVp8x(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("returns null for something it does not recognise, rather than guessing", () => {
    expect(imageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });

  it("does not loop forever on a malformed JPEG", () => {
    const broken = new Uint8Array(64);
    broken.set([0xff, 0xd8], 0);
    broken.set([0xff, 0xe0, 0x00, 0x00], 2); // a zero-length segment
    expect(imageSize(broken)).toBeNull();
  });
});

describe("preparing an upload", () => {
  const upload = (overrides: Partial<Parameters<typeof prepareUpload>[1]> = {}) =>
    prepareUpload(DEFAULT_CONFIG, {
      fileName: "Hero Image.png",
      type: "image/png",
      bytes: png(1200, 800),
      ...overrides,
    });

  it("commits into the configured media directory, and serves from the public prefix", () => {
    const result = upload();
    expect(result.path).toMatch(/^public\/media\/hero-image-[0-9a-f]{8}\.png$/);
    expect(result.src).toMatch(/^\/media\/hero-image-[0-9a-f]{8}\.png$/);
  });

  it("records the dimensions it read", () => {
    expect(upload()).toMatchObject({ width: 1200, height: 800 });
  });

  it("gives identical bytes the same name, and edited bytes a new one", () => {
    const first = upload();
    const same = upload();
    const different = upload({ bytes: png(1201, 800) });

    expect(same.path).toBe(first.path);
    expect(different.path).not.toBe(first.path);
  });

  it("refuses a type that is not an image", () => {
    expect(() => upload({ type: "application/pdf", fileName: "invoice.pdf" })).toThrow(UploadError);
    expect(() => upload({ type: "application/pdf", fileName: "invoice.pdf" })).toThrow(
      /image\/png/,
    );
  });

  it("refuses SVG, which is a script-bearing document", () => {
    expect(() => upload({ type: "image/svg+xml", fileName: "logo.svg" })).toThrow(UploadError);
  });

  it("refuses a file over the size limit, and says how big it was", () => {
    expect(() => upload({ bytes: new Uint8Array(MAX_BYTES + 1) })).toThrow(/over the 8.0 MB limit/);
  });

  it("refuses an empty file", () => {
    expect(() => upload({ bytes: new Uint8Array(0) })).toThrow(/is empty/);
  });

  it("survives a name that is nothing but punctuation", () => {
    expect(upload({ fileName: "###.png" }).path).toMatch(
      /^public\/media\/untitled-[0-9a-f]{8}\.png$/,
    );
  });
});
