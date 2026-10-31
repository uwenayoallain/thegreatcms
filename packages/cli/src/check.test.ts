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

const check = (
  files: Record<string, string>,
  schemaSource = SCHEMA,
  configSource = "version: 1\n",
) =>
  checkSite({
    schema: parseSchema(schemaSource, { file: ".cms/schema.yaml" }),
    config: parseConfig(configSource, ".cms/config.yaml"),
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
    expect(report.checked).toEqual({ regions: 2, entries: 1, media: 1, links: 0 });
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

  it("finds an image inside a block inside a blocks field", async () => {
    const schema = `version: 1
blocks:
  slide:
    fields:
      image: { type: image, required: true }
  carousel:
    fields:
      slides: { type: blocks, allow: [slide] }
regions:
  home.hero:
    fields:
      carousel: { type: blocks, allow: [carousel] }
`;
    const report = await check(
      {
        "content/cms/home.hero.json": JSON.stringify({
          carousel: [
            {
              _type: "carousel",
              slides: [{ _type: "slide", image: { src: "/media/gone.png", alt: "Missing" } }],
            },
          ],
        }),
      },
      schema,
    );

    expect(codes(report.issues)).toEqual(["missing_media"]);
    expect(report.issues[0]?.path).toBe("carousel[0].slides[0].image");
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

/** A pages entry holding the given sections. */
const page = (sections: unknown[]) => ({
  "content/pages/home.json": JSON.stringify({ title: "Home", sections }),
});

describe("collection entries", () => {
  const POSTS = `version: 1
collections:
  posts:
    path: content/posts
    format: markdown
    fields:
      title: { type: text, required: true, default: Untitled }
      date: { type: date }
`;

  const PAGES = `version: 1
blocks:
  feature:
    fields:
      heading: { type: text, required: true }
      image: { type: image }
collections:
  pages:
    path: content/pages
    format: json
    fields:
      title: { type: text, required: true }
      sections: { type: blocks, allow: [feature] }
`;

  it("validates an entry as stored, without filling in schema defaults", async () => {
    const report = await check(
      { "content/posts/a.md": "---\ndate: 2026-10-02\n---\n\nBody.\n" },
      POSTS,
    );

    expect(codes(report.issues)).toContain("required");
  });

  it("checks alt text on images inside sections of an entry", async () => {
    const report = await check(
      page([
        { _type: "feature", heading: "Hi", image: { src: "https://example.com/a.png", alt: "" } },
      ]),
      PAGES,
    );

    expect(codes(report.issues)).toContain("empty_alt");
  });

  it("checks required fields inside sections of an entry", async () => {
    const report = await check(page([{ _type: "feature" }]), PAGES);

    expect(
      report.issues.some((issue) => issue.code === "required" && /sections/.test(issue.path ?? "")),
    ).toBe(true);
  });
});

describe("the schema itself", () => {
  it("reports a misspelt key that every reader would silently ignore", async () => {
    const source = SCHEMA.replace(
      "heading: { type: text, required: true }",
      "heading: { type: text, requird: true }",
    );
    const report = await checkSite({
      schema: parseSchema(source, { file: ".cms/schema.yaml" }),
      config: parseConfig("version: 1\n", ".cms/config.yaml"),
      files: site({}),
      schemaSource: { name: ".cms/schema.yaml", source },
    });

    expect(codes(report.issues)).toContain("unknown_schema_key");
    expect(report.issues[0]?.path).toBe("regions.home.hero.fields.heading.requird");
  });
});

/** A site with a page builder, posts with a Markdown body, and routes for both. */
const SITE = `version: 1
regions:
  site.footer:
    fields:
      logo: { type: image, default: { src: /media/default-logo.png, alt: Logo } }
      cta: { type: link }
      note: { type: richtext }
collections:
  pages:
    path: content/pages
    format: json
    fields:
      title: { type: text, required: true }
      body: { type: richtext }
  updates:
    path: content/updates
    format: markdown
    body: body
    fields:
      title: { type: text, required: true }
      body: { type: richtext }
`;

const ROUTES = `version: 1
preview:
  paths:
    pages: { home: "/", "*": "/{slug}" }
    updates: "/updates/{slug}"
`;

const footer = (value: Record<string, unknown>) => ({
  "content/cms/site.footer.json": JSON.stringify(value),
});
const pageWith = (slug: string, html: string) => ({
  [`content/pages/${slug}.json`]: JSON.stringify({ title: slug, body: { html } }),
});
const update = (slug: string, body: string) => ({
  [`content/updates/${slug}.md`]: `---\ntitle: ${slug}\n---\n\n${body}\n`,
});

describe("unused media", () => {
  it("warns about an upload nothing references, without failing", async () => {
    const report = await check({
      "content/cms/home.hero.json": JSON.stringify({
        heading: "Hello",
        shot: { src: "/media/used.png", alt: "Used" },
      }),
      "public/media/used.png": "bytes",
      "public/media/stray.png": "bytes",
      "public/media/.gitkeep": "",
    });

    expect(report.issues).toEqual([]);
    expect(codes(report.warnings)).toEqual(["unused_media"]);
    expect(report.warnings[0]?.file).toBe("public/media/stray.png");
  });

  it("follows content.media and mediaUrlPrefix, as an Astro site sets them", async () => {
    const report = await check(
      {
        "content/cms/home.hero.json": JSON.stringify({
          heading: "Hello",
          shot: { src: "/src/media/hero.jpg", alt: "Hero" },
        }),
        "src/media/hero.jpg": "bytes",
        "src/media/image-1-38777151.png": "bytes",
      },
      SCHEMA,
      "version: 1\ncontent: { media: src/media }\nmediaUrlPrefix: /src/media\n",
    );

    expect(report.issues).toEqual([]);
    expect(report.warnings.map((warning) => warning.file)).toEqual([
      "src/media/image-1-38777151.png",
    ]);
  });

  it("counts rich text, Markdown bodies, links, drafts and schema defaults as references", async () => {
    const report = await check(
      {
        ...footer({ cta: { href: "/media/brochure.pdf" } }),
        ...pageWith("about", '<p><img src="/media/in-html.png" alt="Team"></p>'),
        ...update("hello", "![A chart](/media/in-markdown.png)"),
        ".cms/draft/content/pages/about.json": JSON.stringify({
          title: "About",
          body: { html: '<img src="/media/draft-only.png" alt="New">' },
        }),
        "public/media/brochure.pdf": "bytes",
        "public/media/in-html.png": "bytes",
        "public/media/in-markdown.png": "bytes",
        "public/media/draft-only.png": "bytes",
        "public/media/default-logo.png": "bytes",
        "public/media/my photo.png": "bytes",
        "content/updates/photo.md": "---\ntitle: Photo\n---\n\n![Me](/media/my%20photo.png)\n",
      },
      SITE,
    );

    expect(report.issues).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe("missing media in prose", () => {
  it("reports an image in rich text whose file is not committed", async () => {
    const report = await check(pageWith("about", '<img src="/media/gone.png" alt="Gone">'), SITE);

    expect(codes(report.issues)).toEqual(["missing_media"]);
    expect(report.issues[0]?.path).toBe("body");
  });

  it("reports an image in a Markdown body whose file is not committed", async () => {
    const report = await check(update("hello", "Intro.\n\n![Chart](/media/gone.png)"), SITE);

    expect(codes(report.issues)).toEqual(["missing_media"]);
    expect(report.issues[0]?.file).toBe("content/updates/hello.md");
  });

  it("reports a link to an upload that is not committed", async () => {
    const report = await check(footer({ cta: { href: "/media/gone.pdf?download=1" } }), SITE);

    expect(codes(report.issues)).toEqual(["missing_media"]);
    expect(report.issues[0]?.message).toContain("public/media/gone.pdf");
  });
});

describe("internal links", () => {
  const pages = { ...pageWith("home", "<p>Home</p>"), ...pageWith("about", "<p>About</p>") };

  it("reports a link field to an entry that does not exist", async () => {
    const report = await check(
      { ...pages, ...footer({ cta: { href: "/updates/missing" } }) },
      SITE,
      ROUTES,
    );

    expect(codes(report.issues)).toEqual(["broken_link"]);
    expect(report.issues[0]?.path).toBe("cta");
    expect(report.issues[0]?.message).toContain('updates entry "missing"');
  });

  it("resolves through fragments, queries, trailing slashes and .html", async () => {
    const report = await check(
      {
        ...pages,
        ...update("hello", "Hi."),
        ...footer({
          note: {
            html: [
              '<a href="/about#team">Team</a>',
              '<a href="/about/?ref=footer">About</a>',
              '<a href="/updates/hello.html">Hello</a>',
              '<a href="/">Home</a>',
            ].join(""),
          },
        }),
      },
      SITE,
      ROUTES,
    );

    expect(report.issues).toEqual([]);
    expect(report.checked.links).toBe(4);
  });

  it("reports a broken link in rich text and in a Markdown body", async () => {
    const report = await check(
      {
        ...pages,
        ...pageWith("contact", '<p><a href="/abuot">About us</a></p>'),
        ...update("hello", "See [the launch](/updates/launch)."),
      },
      SITE,
      ROUTES,
    );

    expect(codes(report.issues)).toEqual(["broken_link", "broken_link"]);
    expect(report.issues.map((issue) => issue.file)).toEqual([
      "content/pages/contact.json",
      "content/updates/hello.md",
    ]);
  });

  it("reports / when the entry the map puts there is missing", async () => {
    const report = await check(
      { ...pageWith("about", "<p>About</p>"), ...footer({ cta: { href: "/" } }) },
      SITE,
      ROUTES,
    );

    expect(codes(report.issues)).toEqual(["broken_link"]);
    expect(report.issues[0]?.message).toContain('pages entry "home"');
  });

  it("leaves alone routes the site writes itself, external links and protocol-relative ones", async () => {
    const report = await check(
      {
        ...pages,
        ...footer({
          note: {
            html: [
              '<a href="/updates">All updates</a>',
              '<a href="/assets/report.pdf">Report</a>',
              '<a href="//cdn.example.com/x">CDN</a>',
              '<a href="https://example.com/nope">Elsewhere</a>',
              '<a href="#top">Top</a>',
            ].join(""),
          },
        }),
      },
      SITE,
      ROUTES,
    );

    expect(report.issues).toEqual([]);
  });

  it("checks nothing against routes when the config declares none", async () => {
    const report = await check(footer({ cta: { href: "/anything" } }), SITE);

    expect(report.issues).toEqual([]);
    expect(report.checked.links).toBe(1);
  });

  it("ignores links and headings inside code", async () => {
    const report = await check(
      {
        ...pages,
        ...update(
          "hello",
          "## Setup\n\n```sh\n# install it\n[x](/updates/nope)\n```\n\nRun `[x](/nope)`.",
        ),
      },
      SITE,
      ROUTES,
    );

    expect(report.issues).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe("rich-text hygiene", () => {
  it("warns about a link with no text", async () => {
    const report = await check(
      pageWith(
        "about",
        '<a href="https://example.com"></a><a href="https://example.com"><img src="https://example.com/x.png" alt=""></a>',
      ),
      SITE,
    );

    expect(report.issues).toEqual([]);
    expect(codes(report.warnings)).toEqual(["empty_link_text", "empty_link_text"]);
  });

  it("takes an image's alt or an aria-label as a link's text", async () => {
    const report = await check(
      pageWith(
        "about",
        '<a href="https://example.com"><img src="https://example.com/x.png" alt="Partner"></a><a href="https://example.com" aria-label="Partner"></a><a href="https://example.com"><code>npm</code></a>',
      ),
      SITE,
    );

    expect(report.warnings).toEqual([]);
  });

  it("warns about an empty Markdown link", async () => {
    const report = await check(update("hello", "A [](https://example.com) link."), SITE);

    expect(codes(report.warnings)).toEqual(["empty_link_text"]);
  });

  it("warns once per field when headings skip a level", async () => {
    const report = await check(
      pageWith("about", "<h2>One</h2><h4>Two</h4><h3>Three</h3><h5>Four</h5>"),
      SITE,
    );

    expect(codes(report.warnings)).toEqual(["skipped_heading_level"]);
    expect(report.warnings[0]?.message).toContain("h2 → h4, h3 → h5");
  });

  it("allows going back up, and an outline that steps down one level at a time", async () => {
    const report = await check(
      {
        ...pageWith("about", "<h3>Deep start</h3><h4>Down</h4><h2>Up</h2><h3>Down</h3>"),
        ...update("hello", "## One\n\n### Two\n\n## Three"),
      },
      SITE,
    );

    expect(report.warnings).toEqual([]);
  });

  it("warns about a skip in a Markdown body", async () => {
    const report = await check(update("hello", "## One\n\n#### Two"), SITE);

    expect(codes(report.warnings)).toEqual(["skipped_heading_level"]);
  });
});

describe("the report with warnings", () => {
  it("lists warnings apart from problems, and still says OK", async () => {
    const report = await check({ "public/media/stray.png": "bytes" });
    const text = formatReport(report);

    expect(text).toContain("1 warning:");
    expect(text).toContain("content: OK, 1 warning");
    expect(text).not.toContain("problem");
  });

  it("counts both when there are problems and warnings", async () => {
    const report = await check({
      "content/cms/home.hero.json": "{}",
      "public/media/stray.png": "bytes",
    });

    expect(formatReport(report)).toContain("1 problem, 1 warning; checked");
  });

  it("gives warnings their own array in JSON, and ok stays true", async () => {
    const parsed = JSON.parse(reportAsJson(await check({ "public/media/stray.png": "bytes" }))) as {
      ok: boolean;
      issues: unknown[];
      warnings: Array<{ code: string; file: string; fix: string }>;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toEqual([]);
    expect(parsed.warnings[0]).toMatchObject({
      code: "unused_media",
      file: "public/media/stray.png",
    });
    expect(parsed.warnings[0]?.fix).toBeTruthy();
  });
});

describe("references", () => {
  const REFS = `version: 1
regions:
  home.featured:
    fields:
      lead: { type: reference, collection: services }
      more: { type: reference, collection: services, multiple: true }
collections:
  services:
    path: content/services
    format: json
    fields:
      title: { type: text, required: true }
  posts:
    path: content/posts
    format: json
    fields:
      title: { type: text, required: true }
      related: { type: reference, collection: posts, multiple: true }
`;

  it("finds a reference to an entry that does not exist, in regions and in entries", async () => {
    const report = await check(
      {
        "content/cms/home.featured.json": JSON.stringify({
          lead: "research",
          more: ["research", "audit"],
        }),
        "content/services/research.json": JSON.stringify({ title: "Research" }),
        "content/posts/first.json": JSON.stringify({ title: "First", related: ["second"] }),
      },
      REFS,
    );
    const missing = report.issues.filter((issue) => issue.code === "missing_reference");
    expect(missing.map((issue) => `${issue.file} ${issue.path}`)).toEqual([
      "content/cms/home.featured.json more[1]",
      "content/posts/first.json related[0]",
    ]);
    expect(missing[0]?.message).toContain('"audit"');
  });

  it("is quiet when every reference lands", async () => {
    const report = await check(
      {
        "content/cms/home.featured.json": JSON.stringify({ lead: "research" }),
        "content/services/research.json": JSON.stringify({ title: "Research" }),
      },
      REFS,
    );
    expect(codes(report.issues)).toEqual([]);
  });
});
