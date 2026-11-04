import { describe, expect, it } from "vitest";
import { parseConfig, previewPath } from "./config.js";
import type { SpecError } from "./errors.js";

describe("preview paths", () => {
  const config = parseConfig(`version: 1
preview:
  paths:
    pages: { home: "/", "*": "/{slug}" }
    updates: "/updates/{slug}"
    visit: "/visit/"
`);

  it("opens a region on the page it names, and anything else on the front page", () => {
    expect(previewPath(config, { region: "visit" })).toBe("/visit/");
    expect(previewPath(config, { region: "home.hero" })).toBe("/");
    // A collection's pattern is not a page a region can be on.
    expect(previewPath(config, { region: "updates" })).toBe("/");
    expect(previewPath(config, { region: "constructor" })).toBe("/");
  });

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

describe("parseConfig", () => {
  it("fills in every default", () => {
    expect(parseConfig("version: 1\n")).toEqual({
      version: 1,
      content: { regions: "content/cms", media: "public/media" },
      mediaUrlPrefix: "/media",
      publish: {
        branch: "main",
        draftBranchPrefix: "cms/draft",
        commitMessage: "content: update {summary}",
      },
    });
  });

  it("refuses a path that leaves the repository, and says where", () => {
    try {
      parseConfig("version: 1\ncontent:\n  media: ../shared\n");
      throw new Error("should have thrown");
    } catch (err) {
      const issue = (err as SpecError).issues[0];
      expect(issue).toMatchObject({ code: "invalid_config", path: "content.media" });
      expect(issue?.fix).toContain("repo-relative");
    }
  });
});
