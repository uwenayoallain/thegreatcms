/** The cases a repository actually gets into, each of them silent until now. */

import { parseConfig, parseSchema } from "@greatcms/spec";
import { describe, expect, it } from "vitest";
import { checkSite, formatReport, reportAsJson, type CheckPort } from "./check.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text, required: true }
      shot: { type: image }
  home.body:
    type: blocks
    allow: [quote]
  about.intro:
    fields:
      heading: { type: text, default: About }
blocks:
  quote:
    fields:
      text: { type: text, required: true }
collections:
  posts:
    path: content/posts
    format: markdown
    body: body
    fields:
      title: { type: text, required: true }
      body: { type: richtext }
`;

/** A site held in a map, so a case is the files it contains and nothing else. */
function site(files: Record<string, string>): CheckPort {
  return {
    async read(path) {
      return files[path] ?? null;
    },
    async list(dir) {
      return Object.keys(files).filter(
        (path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"),
      );
    },
    async exists(path) {
      return path in files;
    },
  };
}

const check = (files: Record<string, string>, schemaSource = SCHEMA) =>
  checkSite({
    schema: parseSchema(schemaSource, { file: ".cms/schema.yaml" }),
    config: parseConfig("version: 1\n", ".cms/config.yaml"),
    files: site(files),
  });

const codes = (issues: readonly { code: string }[]) => issues.map((issue) => issue.code);

describe("a site that is fine", () => {
  it("passes with no content at all", async () => {
    const report = await check({});

    expect(report.issues).toEqual([]);
    // Every region falls back to defaults, which is the promise, not a warning.
    expect(report.defaults).toEqual(["home.hero", "home.body", "about.intro"]);
    expect(report.checked.regions).toBe(0);
  });

  it("passes with valid content, and counts what it looked at", async () => {
    const report = await check({
      "content/cms/home.hero.json": JSON.stringify({
        heading: "Hello",
        shot: { src: "/media/a.png", alt: "A photo" },
        _meta: { updatedBy: "studio" },
      }),
      "content/cms/home.body.json": JSON.stringify({
        blocks: [{ _type: "quote", text: "Quoted" }],
      }),
      "public/media/a.png": "bytes",
      "content/posts/hello.md": "---\ntitle: Hello\n---\n\nBody copy.\n",
    });

    expect(report.issues).toEqual([]);
    expect(report.checked).toEqual({ regions: 2, entries: 1, media: 1 });
    expect(formatReport(report)).toContain("content: OK");
  });
});

describe("content the schema would reject", () => {
  it("reports a required field that is missing", async () => {
    const report = await check({ "content/cms/home.hero.json": "{}" });

    expect(codes(report.issues)).toContain("required");
    expect(report.issues[0]?.file).toBe("content/cms/home.hero.json");
  });

  it("reports a field the schema no longer has", async () => {
    const report = await check({
      "content/cms/home.hero.json": JSON.stringify({ heading: "Hi", subtitle: "Dropped" }),
    });

    expect(codes(report.issues)).toEqual(["unknown_field"]);
    expect(report.issues[0]?.fix).toContain("subtitle");
  });

  it("reports an invalid block inside a blocks region", async () => {
    const report = await check({
      "content/cms/home.body.json": JSON.stringify({ blocks: [{ _type: "quote" }] }),
    });

    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.path).toContain("blocks[0]");
  });

  it("reports unreadable JSON instead of throwing", async () => {
    const report = await check({ "content/cms/home.hero.json": "{ not json" });

    expect(codes(report.issues)).toEqual(["unreadable_content"]);
  });

  it("reports a collection entry that is missing its title", async () => {
    const report = await check({ "content/posts/hello.md": "---\nslug: hello\n---\n\nBody.\n" });

    expect(codes(report.issues)).toContain("required");
    expect(report.issues[0]?.path).toMatch(/^posts\./);
  });

  it("ignores files in a collection directory that are not entries", async () => {
    const report = await check({ "content/posts/README.txt": "not an entry" });

    expect(report.issues).toEqual([]);
    expect(report.checked.entries).toBe(0);
  });
});

describe("content nothing renders", () => {
  it("reports a file with no region in the schema", async () => {
    const report = await check({ "content/cms/home.old.json": "{}" });

    expect(codes(report.issues)).toEqual(["orphaned_content"]);
    expect(report.issues[0]?.message).toContain("home.old");
  });

  it("says nothing about a file that is not a region document", async () => {
    const report = await check({ "content/cms/notes.txt": "scratch" });

    expect(report.issues).toEqual([]);
  });
});

describe("media", () => {
  it("reports an image that points at a file nobody committed", async () => {
    const report = await check({
      "content/cms/home.hero.json": JSON.stringify({
        heading: "Hello",
        shot: { src: "/media/gone.png", alt: "Missing" },
      }),
    });

    expect(codes(report.issues)).toEqual(["missing_media"]);
    expect(report.issues[0]?.message).toContain("public/media/gone.png");
    expect(report.issues[0]?.path).toBe("shot");
  });

  it("leaves an external URL alone", async () => {
    const report = await check({
      "content/cms/home.hero.json": JSON.stringify({
        heading: "Hello",
        shot: { src: "https://cdn.example.com/a.png", alt: "Remote" },
      }),
    });

    expect(report.issues).toEqual([]);
  });
});

describe("the report", () => {
  it("is machine-readable, with the fix on every issue", async () => {
    const report = await check({ "content/cms/home.hero.json": "{}" });
    const parsed = JSON.parse(reportAsJson(report)) as {
      ok: boolean;
      issues: Array<{ code: string; file: string; message: string; fix: string }>;
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.issues[0]?.file).toBe("content/cms/home.hero.json");
    expect(parsed.issues[0]?.fix).toBeTruthy();
  });

  it("names the regions still on defaults without calling them a problem", async () => {
    const text = formatReport(await check({}));

    expect(text).toContain("rendering schema defaults");
    expect(text).not.toContain("problem");
  });
});
