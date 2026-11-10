/** MDX collections: prose with components in it, which a WYSIWYG editor would eat. */

import { entryExtension, hasFrontmatter, parseSchema } from "@greatcms/spec";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth.js";
import { get, makeSite, post, signedIn, type Fixture } from "./site.js";

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

const NESTED_COLLECTION_SCHEMA = `${NESTED_SCHEMA}
collections:
  pages:
    path: content/pages
    format: json
    slug: title
    fields:
      title: { type: text, required: true }
      sections: { type: blocks, allow: [grid] }
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
    expect((await publish()).status).toBe(303);

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
 * Nested blocks: the PayloadCMS-shaped case: a managed section holding
 * composed components rather than a flat list of fields.
 */
describe("a block that contains blocks", () => {
  beforeEach(() => {
    site = makeSite({ schema: NESTED_SCHEMA });
  });

  const stored = () => JSON.parse(site.read("content/cms/home.body.json"));

  it("renders an explicit add control for a nested block list", async () => {
    // A nested picker exists only once its parent does, so add the grid first.
    const body = await (
      await post(site, "/sites/site-1/regions/home.body", { action: "add", addType: "grid" })
    ).text();

    expect(body).toContain("Card grid");
    expect(body).toContain('name="nestedAdd[blocks][0][cards]"');
    expect(body).toContain('value="nested:add:blocks.0.cards"');
    const { document } = new JSDOM(body).window;
    const nested = document.querySelector(".blocks-field");
    expect(nested?.querySelector('select[name="nestedAdd[blocks][0][cards]"]')).toBeNull();
    expect(
      nested?.querySelector<HTMLButtonElement>('button[value="nested:add:blocks.0.cards"]')
        ?.textContent,
    ).toContain("Add card");
  });

  it("adds a nested block without publishing or requiring invalid empty fields", async () => {
    const response = await post(site, "/sites/site-1/regions/home.body", {
      "f[blocks][0][_type]": "grid",
      "f[blocks][0][heading]": "What you get",
      "nestedAdd[blocks][0][cards]": "card",
      action: "nested:add:blocks.0.cards",
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('name="f[blocks][0][cards][0][title]"');
    expect(body).toContain('value="nested:remove:blocks.0.cards:0"');
    const { document } = new JSDOM(body).window;
    expect(document.querySelector<HTMLDetailsElement>(".block-collapsible details")?.open).toBe(
      true,
    );
    expect(document.querySelector<HTMLDetailsElement>(".nested-collapsible details")?.open).toBe(
      true,
    );
    expect(site.exists("content/cms/home.body.json")).toBe(false);
  });

  it("reorders nested blocks on the server", async () => {
    const response = await post(site, "/sites/site-1/regions/home.body", {
      "f[blocks][0][_type]": "grid",
      "f[blocks][0][heading]": "What you get",
      "f[blocks][0][cards][0][_type]": "card",
      "f[blocks][0][cards][0][title]": "First",
      "f[blocks][0][cards][1][_type]": "card",
      "f[blocks][0][cards][1][title]": "Second",
      action: "nested:up:blocks.0.cards:1",
    });
    const body = await response.text();
    expect(body.indexOf('value="Second"')).toBeLessThan(body.indexOf('value="First"'));
    expect(site.exists("content/cms/home.body.json")).toBe(false);
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

  it("removes a nested block without publishing", async () => {
    const response = await post(site, "/sites/site-1/regions/home.body", {
      "f[blocks][0][_type]": "grid",
      "f[blocks][0][cards][0][_type]": "card",
      "f[blocks][0][cards][0][title]": "Kept",
      "f[blocks][0][cards][1][_type]": "card",
      "f[blocks][0][cards][1][title]": "Discarded",
      action: "nested:remove:blocks.0.cards:1",
    });

    const body = await response.text();
    expect(body).toContain("Kept");
    expect(body).not.toContain('value="Discarded"');
    expect(site.exists("content/cms/home.body.json")).toBe(false);
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

describe("nested blocks in a collection entry", () => {
  beforeEach(() => {
    site = makeSite({ schema: NESTED_COLLECTION_SCHEMA });
  });

  it("adds a section without publishing the entry", async () => {
    const response = await post(site, "/sites/site-1/collections/pages/new", {
      "f[title]": "About",
      "nestedAdd[sections]": "grid",
      action: "nested:add:sections",
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('name="f[sections][0][heading]"');
    expect(site.exists("content/pages/about.json")).toBe(false);
  });

  it.each(["add", "up", "remove"])(
    "keeps the containing section open after a nested %s",
    async (verb) => {
      const response = await post(site, "/sites/site-1/collections/pages/new", {
        "f[title]": "About",
        "f[sections][0][_type]": "grid",
        "f[sections][0][heading]": "Our work",
        "f[sections][0][cards][0][_type]": "card",
        "f[sections][0][cards][0][title]": "First",
        "f[sections][0][cards][1][_type]": "card",
        "f[sections][0][cards][1][title]": "Second",
        "nestedAdd[sections][0][cards]": "card",
        action:
          verb === "add" ? "nested:add:sections.0.cards" : `nested:${verb}:sections.0.cards:1`,
      });
      const { document } = new JSDOM(await response.text()).window;
      const parent = document.querySelector<HTMLDetailsElement>(".nested-collapsible > details");

      expect(response.status).toBe(200);
      expect(parent?.open).toBe(true);
      if (verb !== "remove") {
        const index = verb === "add" ? 2 : 0;
        const field = document.querySelector(
          `input[name="f[sections][0][cards][${index}][title]"]`,
        );
        expect(field?.closest("details")?.open).toBe(true);
      }
      expect(site.exists("content/pages/about.json")).toBe(false);
    },
  );
});

describe("an editor and an MDX body", () => {
  /** An editor's session: signed in as a person, not as the owner. */
  async function editor() {
    site.store.addEditor({
      name: "Ed",
      email: "ed@example.com",
      passwordHash: hashPassword("an editor's long password"),
    });
    const response = await site.app.request("/sign-in", {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "ed@example.com", password: "an editor's long password" }),
    });
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0] as string)
      .find((line) => line.startsWith("greatcms_session="));
    return { ...signedIn, cookie: cookie as string };
  }

  beforeEach(async () => {
    site = makeSite({ schema: SCHEMA });
    await post(site, "/sites/site-1/collections/guides/new", {
      "f[title]": "Latency",
      "f[content]": MDX_BODY,
    });
  });

  it("cannot change the source, because MDX runs when the site builds", async () => {
    const response = await post(
      site,
      "/sites/site-1/collections/guides/latency",
      {
        "f[title]": "Latency, revised",
        "f[content]": "export const leak = process.env;\n\n<script>alert(1)</script>",
      },
      await editor(),
    );

    expect(response.status).toBe(200);
    const file = site.read("src/content/guides/latency.mdx");
    expect(file).toContain("title: Latency, revised");
    expect(file).toContain('<Chart data={[1, 2, 3]} caption="p99 latency" />');
    expect(file).not.toContain("process.env");
  });

  it("sees it read-only, and says why", async () => {
    const body = await (
      await get(site, "/sites/site-1/collections/guides/latency", await editor())
    ).text();
    const textarea = new JSDOM(body).window.document.querySelector("textarea.source");

    expect(textarea?.hasAttribute("readonly")).toBe(true);
    expect(body).toContain("owner can change it");
  });
});
