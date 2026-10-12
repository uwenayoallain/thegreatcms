/** Rich text is stored as sanitized HTML, so a public site can print it as-is. */

import { describe, expect, it } from "vitest";
import { sanitizeRichText } from "../src/sanitize.js";
import { makeSite, post, SITE_ID } from "./site.js";

describe("sanitizeRichText", () => {
  it("keeps everything the editor can produce, unchanged", () => {
    const html =
      '<h2>About</h2><p>We <strong>build</strong> and <em>advise</em>, see <a href="/contact" title="Contact">us</a>.</p>' +
      '<ul><li><p>One</p></li></ul><ol start="3"><li><p>Three</p></li></ol><blockquote><p>Quote</p></blockquote>' +
      '<pre><code>x &lt; y</code></pre><p>Line<br>break</p><hr><p><img src="/media/a.png" alt="A" title="T"></p>';
    expect(sanitizeRichText(html)).toBe(html);
  });

  it("drops scripts, styles and frames with everything inside them", () => {
    expect(
      sanitizeRichText(
        "<p>Hi</p><script>alert(1)</script><style>p{}</style><iframe src=x></iframe>",
      ),
    ).toBe("<p>Hi</p>");
  });

  it("drops event handlers and any attribute the editor never writes", () => {
    expect(sanitizeRichText('<p onclick="x()" style="color:red" class="c" id="i">Hi</p>')).toBe(
      "<p>Hi</p>",
    );
    expect(sanitizeRichText('<img src="/a.png" onerror="x()" alt="">')).toBe(
      '<img src="/a.png" alt="">',
    );
  });

  it("refuses a link or image that would run code", () => {
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeRichText('<a href=" JaVaScRiPt:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeRichText('<a href="java&#x09;script:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeRichText('<img src="data:text/html,x" alt="">')).toBe('<img alt="">');
    expect(sanitizeRichText('<a href="https://example.com/?a=1&amp;b=2">x</a>')).toBe(
      '<a href="https://example.com/?a=1&amp;b=2">x</a>',
    );
    expect(sanitizeRichText('<a href="mailto:hi@example.com">x</a>')).toBe(
      '<a href="mailto:hi@example.com">x</a>',
    );
  });

  it("unwraps an unknown element but keeps its text", () => {
    expect(sanitizeRichText("<p><span>kept</span> <font>too</font></p>")).toBe("<p>kept too</p>");
  });

  it("escapes text, so markup smuggled in as text stays text", () => {
    expect(sanitizeRichText("<p>&lt;script&gt;x&lt;/script&gt; &amp; “quotes”</p>")).toBe(
      "<p>&lt;script&gt;x&lt;/script&gt; &amp; “quotes”</p>",
    );
  });

  it("closes what an author left open, and ignores stray closing tags", () => {
    expect(sanitizeRichText("<p><strong>bold")).toBe("<p><strong>bold</strong></p>");
    expect(sanitizeRichText("text</em></div>")).toBe("text");
  });
});

describe("publishing rich text", () => {
  it("stores the sanitized HTML, whatever the form posted", async () => {
    const site = makeSite({
      schema: `version: 1
regions:
  home.hero:
    fields:
      body: { type: richtext }
`,
    });
    try {
      await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
        headSha: site.head(),
        action: "publish",
        "f[body]": '<p onmouseover="steal()">Hello</p><script>steal()</script>',
      });
      expect(JSON.parse(site.read("content/cms/home.hero.json")).body).toEqual({
        html: "<p>Hello</p>",
      });
    } finally {
      site.cleanup();
    }
  });
});
