/** An image already in the repository shows in the editor, served by the studio rather than the site. */

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { makeSite, signedIn, SITE_ID, type Fixture } from "./site.js";

const SCHEMA = `version: 1
blocks:
  logo:
    fields:
      image: { type: image, required: true }
regions:
  home.hero:
    fields:
      heading: { type: text }
      shot: { type: image }
      logos: { type: blocks, allow: [logo] }
`;

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;

let site: Fixture;
afterEach(() => site?.cleanup());

function withMedia(config = "version: 1\n") {
  site = makeSite({
    schema: SCHEMA,
    config,
    files: {
      "content/cms/home.hero.json": JSON.stringify({
        shot: { src: "/media/team-1a2b3c4d.png", alt: "The team" },
        logos: [{ _type: "logo", image: { src: "/media/partner-5e6f7a8b.svg", alt: "Partner" } }],
      }),
      "public/media/partner-5e6f7a8b.svg": SVG,
    },
  });
  writeFileSync(join(site.root, "public/media/team-1a2b3c4d.png"), PNG);
  return site;
}

const get = (path: string, headers: Record<string, string> = signedIn) =>
  site.app.request(path, { headers });

async function thumbnails(): Promise<string[]> {
  const response = await get(`/sites/${SITE_ID}/regions/home.hero`);
  const document = new JSDOM(await response.text()).window.document;
  return [...document.querySelectorAll(".preview-thumb img")].map(
    (img) => img.getAttribute("src") ?? "",
  );
}

describe("an image that is already committed", () => {
  it("previews from the studio, including one inside a block", async () => {
    withMedia();

    expect(await thumbnails()).toEqual([
      `/sites/${SITE_ID}/media/team-1a2b3c4d.png`,
      `/sites/${SITE_ID}/media/partner-5e6f7a8b.svg`,
    ]);

    const image = await get(`/sites/${SITE_ID}/media/team-1a2b3c4d.png`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
  });

  it("follows the media folder and URL prefix the site configured", async () => {
    withMedia("version: 1\ncontent:\n  media: src/media\nmediaUrlPrefix: /src/media\n");
    site.write(
      "content/cms/home.hero.json",
      JSON.stringify({ shot: { src: "/src/media/a.png", alt: "A" } }),
    );
    mkdirSync(join(site.root, "src/media"), { recursive: true });
    writeFileSync(join(site.root, "src/media/a.png"), PNG);

    expect(await thumbnails()).toEqual([`/sites/${SITE_ID}/media/a.png`]);
    expect((await get(`/sites/${SITE_ID}/media/a.png`)).status).toBe(200);
  });

  it("serves an SVG so that a script inside it can never run", async () => {
    withMedia();
    const svg = await get(`/sites/${SITE_ID}/media/partner-5e6f7a8b.svg`);

    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("is behind sign-in, and serves nothing but images from the media folder", async () => {
    withMedia();
    symlinkSync(join(site.root, ".cms/config.yaml"), join(site.root, "public/media/link.png"));

    expect((await get(`/sites/${SITE_ID}/media/team-1a2b3c4d.png`, {})).status).toBe(303);
    const names = ["link.png", "..%2F..%2F.cms%2Fschema.yaml", "missing.png", "notes.txt"];
    const statuses = await Promise.all(
      names.map(async (name) => (await get(`/sites/${SITE_ID}/media/${name}`)).status),
    );
    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  it("leaves an image on another host alone", async () => {
    withMedia();
    site.write(
      "content/cms/home.hero.json",
      JSON.stringify({ shot: { src: "https://cdn.example.com/a.png", alt: "Remote" } }),
    );

    expect(await thumbnails()).toEqual(["https://cdn.example.com/a.png"]);
  });
});
