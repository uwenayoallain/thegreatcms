/** MDX collections: prose with components in it, which a WYSIWYG editor would eat. */

import { entryExtension, hasFrontmatter, parseSchema } from "@greatcms/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get, makeSite, post, type Fixture } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text, required: true }
collections:
  guides:
    label: Guides
    path: src/content/guides
    format: mdx
    body: content
    slug: title
    fields:
      title: { type: text, required: true }
      content: { type: richtext }
`;

const NESTED_SCHEMA = `version: 1
blocks:
  card:
    label: Card
    fields:
      title: { type: text, required: true }
      body: { type: text }
  grid:
    label: Card grid
    fields:
      heading: { type: text }
      cards: { type: blocks, allow: [card] }
regions:
  home.body:
    type: blocks
    allow: [grid]
`;

/** The kind of body MDX exists for: prose wrapped around a real component. */
const MDX_BODY = `import Chart from "../../components/Chart.astro";

Latency fell after the migration.

<Chart data={[1, 2, 3]} caption="p99 latency" />

The rest is ordinary prose.`;

let site: Fixture;

afterEach(() => site.cleanup());

describe("the standard", () => {
  beforeEach(() => {
    site = makeSite({ schema: SCHEMA });
  });

  it("accepts mdx as a collection format", () => {
    expect(parseSchema(SCHEMA, { file: "s" }).collections.guides?.format).toBe("mdx");
  });

  it("stores it as .mdx, so the build picks it up as MDX and not Markdown", () => {
    expect(entryExtension("mdx")).toBe("mdx");
    expect(entryExtension("markdown")).toBe("md");
    expect(entryExtension("json")).toBe("json");
  });

  it("keeps frontmatter, because MDX is frontmatter plus a body like Markdown is", () => {
    expect(hasFrontmatter("mdx")).toBe(true);
    expect(hasFrontmatter("json")).toBe(false);
  });
});

describe("publishing an MDX entry", () => {
  beforeEach(() => {
    site = makeSite({ schema: SCHEMA });
  });

  const publish = () =>
    post(site, "/sites/site-1/collections/guides/new", {
      "f[title]": "Latency",
      "f[content]": MDX_BODY,
    });

  it("writes an .mdx file with frontmatter above the body", async () => {
    expect((await publish()).status).toBe(200);

    expect(site.exists("src/content/guides/latency.mdx")).toBe(true);
    expect(site.read("src/content/guides/latency.mdx")).toMatch(/^---\ntitle: Latency\n---\n/);
  });

  it("leaves the component in the body exactly as it was typed", async () => {
    await publish();
    const file = site.read("src/content/guides/latency.mdx");

    expect(file).toContain('<Chart data={[1, 2, 3]} caption="p99 latency" />');
    expect(file).toContain('import Chart from "../../components/Chart.astro";');
  });

  it("reads it back into the form unchanged, so editing twice is safe", async () => {
    await publish();
    const body = await (await get(site, "/sites/site-1/collections/guides/latency")).text();

    expect(body).toContain("&lt;Chart data={[1, 2, 3]}");
    expect(body).toContain("import Chart from");
  });
});

describe("the editor for an MDX body", () => {
  it("does not mount the visual editor on it", async () => {
    site = makeSite({ schema: SCHEMA });
    await post(site, "/sites/site-1/collections/guides/new", {
      "f[title]": "Latency",
      "f[content]": MDX_BODY,
    });

    const body = await (await get(site, "/sites/site-1/collections/guides/latency")).text();

    // data-richtext is what the client script binds to. On MDX it must be absent,
    // or ProseMirror would parse the JSX as HTML and drop it on the next save.
    expect(body).not.toContain("data-richtext");
    expect(body).not.toContain("/assets/editor.js");
    expect(body).toContain("MDX source");
  });

  it("still mounts it for an ordinary Markdown collection", async () => {
    site = makeSite({ schema: SCHEMA.replace("format: mdx", "format: markdown") });

    const body = await (await get(site, "/sites/site-1/collections/guides/new")).text();

    expect(body).toContain("data-richtext");
    expect(body).toContain("/assets/editor.js");
  });
});

/**
 * Nested blocks — the PayloadCMS-shaped case: a managed section holding
 * composed components rather than a flat list of fields.
 */
describe("a block that contains blocks", () => {
  beforeEach(() => {
    site = makeSite({ schema: NESTED_SCHEMA });
  });

  const stored = () => JSON.parse(site.read("content/cms/home.body.json"));

  it("renders a type picker for each nested slot, plus a spare one", async () => {
    // A nested picker exists only once its parent does, so add the grid first.
    const body = await (
      await post(site, "/sites/site-1/regions/home.body", { action: "add", addType: "grid" })
    ).text();

    expect(body).toContain("Card grid");
    expect(body).toContain('name="f[blocks][0][cards][0][_type]"');
    expect(body).toContain("Save to add another");
  });

  it("publishes the nesting the editor filled in", async () => {
    const response = await post(site, "/sites/site-1/regions/home.body", {
      "f[blocks][0][_type]": "grid",
      "f[blocks][0][heading]": "What you get",
      "f[blocks][0][cards][0][_type]": "card",
      "f[blocks][0][cards][0][title]": "Content lives in Git",
      "f[blocks][0][cards][0][body]": "Every publish is a commit.",
      "f[blocks][0][cards][1][_type]": "card",
      "f[blocks][0][cards][1][title]": "Nothing at runtime",
      action: "publish",
    });

    expect(response.status).toBe(200);
    const document = stored() as {
      blocks: Array<{ _type: string; cards: Array<{ title: string }> }>;
    };

    expect(document.blocks[0]?._type).toBe("grid");
    expect(document.blocks[0]?.cards.map((card) => card.title)).toEqual([
      "Content lives in Git",
      "Nothing at runtime",
    ]);
  });

  it("drops a nested slot set back to none, which is how you remove one", async () => {
    await post(site, "/sites/site-1/regions/home.body", {
      "f[blocks][0][_type]": "grid",
      "f[blocks][0][cards][0][_type]": "card",
      "f[blocks][0][cards][0][title]": "Kept",
      "f[blocks][0][cards][1][_type]": "",
      "f[blocks][0][cards][1][title]": "Discarded",
      action: "publish",
    });

    const file = site.read("content/cms/home.body.json");
    expect(file).toContain("Kept");
    expect(file).not.toContain("Discarded");
  });

  it("refuses to publish a nested block missing a required field", async () => {
    const response = await post(site, "/sites/site-1/regions/home.body", {
      "f[blocks][0][_type]": "grid",
      "f[blocks][0][cards][0][_type]": "card",
      "f[blocks][0][cards][0][body]": "no title",
      action: "publish",
    });

    expect(response.status).toBe(422);
    expect(site.exists("content/cms/home.body.json")).toBe(false);
    expect(await response.text()).toContain("not valid yet");
  });
});
