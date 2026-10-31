/** A site's tile: its own favicon when it has one, its initial in pixels when it does not. */

import { afterEach, describe, expect, it } from "vitest";
import { type Fixture, get, makeSite } from "./site.js";

const SCHEMA = "version: 1\nregions:\n  home.hero:\n    fields:\n      heading: { type: text }\n";

let site: Fixture;
afterEach(() => site.cleanup());

const tile = async () => {
  const response = await get(site, "/sites/site-1/icon");
  return { response, body: await response.text() };
};

describe("a site's icon", () => {
  it("wraps the site's own favicon, found where its framework keeps one", async () => {
    site = makeSite({
      schema: SCHEMA,
      files: {
        "static/favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
      },
    });
    const { response, body } = await tile();

    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(body).toContain('href="data:image/svg+xml;base64,');
  });

  it("sets the site's initial in pixels when there is none", async () => {
    site = makeSite({ schema: SCHEMA });
    const { body } = await tile();

    expect(body).not.toContain("<image");
    expect(body.match(/<rect /g)?.length).toBeGreaterThan(4);
  });

  it("will not serve a file whose bytes are not the image its name says", async () => {
    site = makeSite({
      schema: SCHEMA,
      files: { "public/favicon.png": "<html><script>alert(1)</script></html>" },
    });
    const { body } = await tile();

    expect(body).not.toContain("<image");
    expect(body).not.toContain("script");
  });

  it("cannot run script if opened directly, and is never sniffed as anything else", async () => {
    site = makeSite({
      schema: SCHEMA,
      files: {
        "public/favicon.svg":
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      },
    });
    const { response } = await tile();

    expect(response.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(response.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("is only for someone signed in", async () => {
    site = makeSite({ schema: SCHEMA });
    expect((await get(site, "/sites/site-1/icon", {})).status).not.toBe(200);
  });
});
