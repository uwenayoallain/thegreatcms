import { describe, expect, it } from "vitest";
import { parseConfig, previewPath } from "./config.js";

describe("preview paths", () => {
  const config = parseConfig(`version: 1
preview:
  paths:
    pages: { home: "/", "*": "/{slug}" }
    updates: "/updates/{slug}"
`);

  it("opens an entry where the site shows it", () => {
    expect(previewPath(config, { collection: "updates", slug: "new-office" })).toBe(
      "/updates/new-office",
    );
    expect(previewPath(config, { collection: "pages", slug: "contact" })).toBe("/contact");
  });

  it("lets one slug be the front page", () => {
    expect(previewPath(config, { collection: "pages", slug: "home" })).toBe("/");
  });

  it("treats a slug that happens to be an Object property as unlisted", () => {
    expect(previewPath(config, { collection: "pages", slug: "constructor" })).toBe("/constructor");
    expect(previewPath(config, { collection: "toString", slug: "x" })).toBe("/");
  });

  it("falls back to the front page for regions and unlisted collections", () => {
    expect(previewPath(config)).toBe("/");
    expect(previewPath(config, { collection: "people", slug: "ann" })).toBe("/");
  });
});
