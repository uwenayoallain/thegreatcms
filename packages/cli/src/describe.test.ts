/** The outline a person or an agent reads before writing content by hand. */

import { parseConfig, parseSchema } from "@greatcms/spec";
import { describe, expect, it } from "vitest";
import { describeSite, formatDescription } from "./describe.js";

const schema = parseSchema(`version: 1
site: { name: Demo, locale: en }
blocks:
  cta:
    variants: [dark, light]
    fields:
      label: { type: text, required: true, max: 40 }
      style: { type: select, options: [solid, outline], default: solid }
regions:
  home.hero:
    fields:
      heading: { type: text, required: true, max: 80, description: Shown in the browser tab too }
      shot: { type: image, when: { field: heading, in: [Hi] } }
  home.body:
    type: blocks
    allow: [cta]
collections:
  people:
    path: content/people
    format: markdown
    fields:
      name: { type: text, required: true }
  posts:
    path: content/posts
    format: json
    fields:
      author: { type: reference, collection: people }
`);
const config = parseConfig(`version: 1
preview:
  paths:
    posts: "/blog/{slug}"
`);

const described = describeSite({
  schema,
  config,
  edited: new Set(["home.hero"]),
  entries: { people: ["ana", "ben"], posts: [] },
});

describe("describing a site", () => {
  it("says where each region's file goes and whether it exists yet", () => {
    expect(described.regions.map(({ id, file, edited }) => ({ id, file, edited }))).toEqual([
      { id: "home.hero", file: "content/cms/home.hero.json", edited: true },
      { id: "home.body", file: "content/cms/home.body.json", edited: false },
    ]);
    expect(described.regions[1]?.blocks).toEqual(["cta"]);
  });

  it("gives each field its type, limits, condition, default and the schema's own hint", () => {
    const [heading, shot] = described.regions[0]!.fields!;
    expect(heading).toEqual({
      name: "heading",
      type: "text",
      required: true,
      rules: ["≤ 80 chars"],
      description: "Shown in the browser tab too",
    });
    expect(shot?.rules).toContain("only when heading is Hi");
    expect(described.blocks[0]?.fields[1]?.rules).toEqual([
      "one of solid | outline",
      'default "solid"',
    ]);
  });

  it("names variants, references, entry files, existing slugs and the page each entry becomes", () => {
    expect(described.blocks[0]?.variants).toEqual(["dark", "light"]);
    const [people, posts] = described.collections;
    expect(people).toMatchObject({ file: "content/people/<slug>.md", entries: ["ana", "ben"] });
    expect(posts).toMatchObject({ file: "content/posts/<slug>.json", preview: "/blog/{slug}" });
    expect(posts?.fields[0]?.type).toBe("reference<people>");
  });

  it("prints one line per field, required marked with !", () => {
    const text = formatDescription(described);
    expect(text).toContain("region home.hero → content/cms/home.hero.json");
    expect(text).toContain("  heading!: text (≤ 80 chars)  # Shown in the browser tab too");
    expect(text).toContain(
      "region home.body → content/cms/home.body.json  (not yet written: schema defaults)",
    );
    expect(text).toContain("block cta  _variant: dark | light (first is the default)");
    expect(text).toContain("  entries: none yet");
    expect(text).toContain("greatcms check");
  });
});
