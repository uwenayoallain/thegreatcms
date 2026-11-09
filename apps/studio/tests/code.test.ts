/** Code snippets coloured on the server: the text must read back exactly, and nothing may run. */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { highlightHtml } from "../src/views/code.js";

const render = (source: string) =>
  new JSDOM(`<body>${String(highlightHtml(source))}</body>`).window.document;

describe("highlighting HTML", () => {
  const form = `<form method="POST" action="https://studio.example.com/f/site/contact">
  <input id="email" name="email" type="email" required>
  <button>Send</button>
</form>`;

  it("reads back as exactly the snippet it was given, so copying it works", () => {
    expect(render(form).querySelector("pre.code code")?.textContent).toBe(form);
  });

  it("marks tag names, attribute names and their values", () => {
    const document = render(form);
    const text = (kind: string) =>
      [...document.querySelectorAll(`.tok-${kind}`)].map((span) => span.textContent);

    expect(text("tag")).toEqual(["form", "input", "button", "button", "form"]);
    expect(text("attr")).toEqual(["method", "action", "id", "name", "type", "required"]);
    expect(text("value")).toContain('"https://studio.example.com/f/site/contact"');
  });

  it("keeps markup in the source as text, whatever it contains", () => {
    const document = render(`<form action="x"><script>alert(1)</script>" onload="y</form>`);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("[onload]")).toBeNull();
    expect(document.querySelector("code")?.textContent).toContain("<script>alert(1)</script>");
  });

  it("leaves what is not a tag as plain text", () => {
    const document = render("a < b and <not a tag");
    expect(document.querySelector("code")?.textContent).toBe("a < b and <not a tag");
    expect(document.querySelectorAll("[class^=tok-]")).toHaveLength(0);
  });
});
