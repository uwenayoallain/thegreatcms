/** Multiple choices and hand-written Markdown, both of which the editor once got wrong. */

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { type Fixture, get, makeSite, signedIn } from "./site.js";

const SCHEMA = `version: 1
collections:
  essays:
    path: content/essays
    format: markdown
    body: body
    slug: title
    fields:
      title: { type: text, required: true }
      tags: { type: select, multiple: true, options: [work, place, language] }
      body: { type: richtext }
`;

let site: Fixture;
afterEach(() => site.cleanup());

const publish = (fields: Array<[string, string]>) =>
  site.app.request("/sites/site-1/collections/essays/new", {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

describe("a multiple choice", () => {
  it("keeps every ticked option, not only the last", async () => {
    site = makeSite({ schema: SCHEMA });
    await publish([
      ["f[title]", "Rivers"],
      ["f[tags]", "work"],
      ["f[tags]", "language"],
    ]);

    expect(site.read("content/essays/rivers.md")).toMatch(/tags:\n {2}- work\n {2}- language/);
  });

  it("keeps a single tick as a list of one", async () => {
    site = makeSite({ schema: SCHEMA });
    await publish([
      ["f[title]", "Hills"],
      ["f[tags]", "place"],
    ]);

    expect(site.read("content/essays/hills.md")).toMatch(/tags:\n {2}- place\n/);
  });

  it("is offered as checkboxes, with no empty choice to tick", async () => {
    site = makeSite({ schema: SCHEMA });
    const document = new JSDOM(
      await (await get(site, "/sites/site-1/collections/essays/new")).text(),
    ).window.document;

    const boxes = [...document.querySelectorAll('input[type="checkbox"][name="f[tags]"]')];
    expect(boxes.map((box) => box.getAttribute("value"))).toEqual(["work", "place", "language"]);
    expect(document.querySelector('select[name="f[tags]"]')).toBeNull();
  });
});

describe("a Markdown body written by hand", () => {
  it("opens in the editor as the headings and paragraphs it is", async () => {
    site = makeSite({
      schema: SCHEMA,
      files: {
        "content/essays/desk.md":
          "---\ntitle: Desk\n---\n\nThe desk is a door.\n\n## Rituals, not routines\n\nA ritual tells you where you are.\n",
      },
    });
    const document = new JSDOM(
      await (await get(site, "/sites/site-1/collections/essays/desk")).text(),
    ).window.document;
    const body = document.querySelector('textarea[name="f[body]"]')?.textContent ?? "";

    expect(body).toContain("<h2>Rituals, not routines</h2>");
    expect(body).toContain("<p>The desk is a door.</p>");
    expect(body).not.toContain("## ");
  });
});
