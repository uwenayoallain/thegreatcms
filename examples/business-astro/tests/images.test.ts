import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it } from "vitest";

const project = fileURLToPath(new URL("..", import.meta.url));
let fixture: string;
const managedImage = (alt: string) => ({ src: "/media/test.png", alt, width: 1, height: 1 });

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "greatcms-business-images-"));
  await Promise.all(
    ["src", ".cms", "content", "astro.config.mjs", "package.json"].map((path) =>
      cp(join(project, path), join(fixture, path), { recursive: true }),
    ),
  );
  await symlink(join(project, "node_modules"), join(fixture, "node_modules"));
  await mkdir(join(fixture, "public/media"), { recursive: true });
  await writeFile(
    join(fixture, "public/media/test.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const update = async (path: string, change: (data: Record<string, unknown>) => void) => {
    const data = JSON.parse(await readFile(join(fixture, path), "utf8"));
    change(data);
    await writeFile(join(fixture, path), JSON.stringify(data));
  };
  await Promise.all([
    update("content/cms/home.hero.json", (data) => {
      data.image = managedImage("Seedling in the field");
    }),
    update("content/cms/site.identity.json", (data) => {
      data.logo = managedImage("Kivu logo");
      (data.owner as Record<string, unknown>).photo = managedImage("Our contact person");
    }),
    update("content/cms/home.sections.json", (data) => {
      const story = (data.blocks as Array<Record<string, unknown>>).find(
        (block) => block._type === "story",
      )!;
      story.image = managedImage("Working with growers");
    }),
    update("content/products/climbing-bean-seed.json", (data) => {
      data.image = managedImage("Climbing bean seed packet");
    }),
    update("content/pages/about.json", (data) => {
      data.image = managedImage("The cooperative");
      (data.sections as Array<Record<string, unknown>>)[0]!.image = managedImage("How we started");
    }),
  ]);
  await promisify(execFile)(process.execPath, [await astroCli(), "build"], {
    cwd: fixture,
    env: { ...process.env, NODE_ENV: "production", ASTRO_TELEMETRY_DISABLED: "1" },
    timeout: 30_000,
  });
}, 40_000);

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

it.each([
  ["index.html", ".hero-image", "Seedling in the field", "eager"],
  ["index.html", ".story-image", "Working with growers", "lazy"],
  ["index.html", ".brand-image", "Kivu logo", "eager"],
  ["products/index.html", ".product-image", "Climbing bean seed packet", "lazy"],
  ["products/climbing-bean-seed/index.html", ".detail-image", "Climbing bean seed packet", "eager"],
  ["about/index.html", ".page-image", "The cooperative", "eager"],
  ["about/index.html", ".story-image", "How we started", "lazy"],
  ["contact/index.html", ".contact-person-image", "Our contact person", "lazy"],
])("renders managed image on %s at %s", async (path, selector, alt, loading) => {
  const html = await readFile(join(fixture, "dist", path), "utf8");
  const document = new JSDOM(html).window.document;
  const image = document.querySelector(selector)!;
  expect(image?.getAttribute("src")).toBe("/media/test.png");
  expect(image.getAttribute("alt")).toBe(alt);
  expect(image.getAttribute("width")).toBe("1");
  expect(image.getAttribute("height")).toBe("1");
  expect(image.getAttribute("loading")).toBe(loading);
  expect(html).not.toMatch(/<script/i);
  expect(document.querySelector('img:not([src]), img[src=""]')).toBeNull();
});

/** Astro's own CLI entry, read from its package.json because the file moved between majors. */
async function astroCli(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(project, "node_modules/astro/package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.astro;
  return join(project, "node_modules/astro", bin);
}
