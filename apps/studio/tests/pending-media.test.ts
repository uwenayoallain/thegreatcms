import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Store } from "../src/db.js";

let folder: string;
let store: Store;
const image = { path: "public/media/test.png", src: "/media/test.png", base64: "aGVsbG8=" };
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "greatcms-pending-media-"));
  store = new Store(join(folder, "studio.sqlite"));
  store.addSite({ id: "one", name: "One", path: folder, devUrl: "" });
  store.addSite({ id: "two", name: "Two", path: folder, devUrl: "" });
});
afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

it("retains validated uploads across studio restarts", () => {
  const token = store.savePendingMedia("one", "region:hero", [image]);
  store.close();
  store = new Store(join(folder, "studio.sqlite"));
  expect(store.pendingMedia("one", "region:hero", token)).toEqual([image]);
});

it("binds tokens to their site and editor, including updates and deletion", () => {
  const token = store.savePendingMedia("one", "region:hero", [image]);
  expect(() => store.pendingMedia("two", "region:hero", token)).toThrow("no longer available");
  expect(() => store.pendingMedia("one", "collection:pages:new", token)).toThrow(
    "no longer available",
  );
  expect(() => store.savePendingMedia("two", "region:hero", [image], token)).toThrow(
    "no longer available",
  );
  store.clearPendingMedia("two", "region:hero", token);
  expect(store.pendingMedia("one", "region:hero", token)).toEqual([image]);
  store.clearPendingMedia("one", "region:hero", token);
  expect(() => store.pendingMedia("one", "region:hero", token)).toThrow("no longer available");
});

it("expires abandoned uploads after 24 hours and removes them on disconnect", () => {
  const token = store.savePendingMedia("one", "region:hero", [image], undefined, 1000);
  expect(store.pendingMedia("one", "region:hero", token, 1001)).toEqual([image]);
  expect(() => store.pendingMedia("one", "region:hero", token, 1000 + 24 * 60 * 60 * 1000)).toThrow(
    "no longer available",
  );
  const other = store.savePendingMedia("two", "region:hero", [image]);
  store.removeSite("two");
  expect(() => store.pendingMedia("two", "region:hero", other)).toThrow("no longer available");
});

it("rejects an oversized pending edit without replacing the previous uploads", () => {
  const token = store.savePendingMedia("one", "region:hero", [image]);
  expect(() =>
    store.savePendingMedia(
      "one",
      "region:hero",
      [{ ...image, base64: "a".repeat(32 * 1024 * 1024) }],
      token,
    ),
  ).toThrow("Too many images");
  expect(store.pendingMedia("one", "region:hero", token)).toEqual([image]);
});

it("serves one pending file without the rest of the edit, and only to its own editor", () => {
  const second = {
    path: "public/media/b.png",
    src: "/media/b.png",
    width: 4,
    height: 3,
    base64: "d29ybGQ=",
  };
  const token = store.savePendingMedia("one", "region:hero", [image, second], undefined, 1000);

  expect(
    Buffer.from(store.pendingMediaFile("one", "region:hero", token, 1, 1001)!.content),
  ).toEqual(Buffer.from("world"));
  expect(store.pendingMedia("one", "region:hero", token, 1001)).toEqual([image, second]);
  expect(store.pendingMediaFile("one", "region:hero", token, 2, 1001)).toBeNull();
  expect(store.pendingMediaFile("two", "region:hero", token, 0, 1001)).toBeNull();
  expect(
    store.pendingMediaFile("one", "region:hero", token, 0, 1000 + 24 * 60 * 60 * 1000),
  ).toBeNull();
});
