/** End-to-end tests for the studio, driven through `app.request` against a real folder. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES_DIR } from "@greatcms/conformance";
import axe from "axe-core";
import { HtmlValidate } from "html-validate";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { compact } from "../src/views/layout.js";
import { Store } from "../src/db.js";
import { createSessionCookie, sessionKey } from "../src/auth.js";
import { makeSite, PASSWORD, SECRET, signedIn, type Fixture } from "./site.js";

const fixture = (path: string) => readFileSync(join(FIXTURES_DIR, path), "utf8");

let site: Fixture;

beforeEach(() => {
  site = makeSite({
    schema: fixture(".cms/schema.yaml"),
    config: fixture(".cms/config.yaml"),
    files: {
      "content/cms/home.hero.json": fixture("content/cms/home.hero.json"),
      "content/cms/home.body.json": fixture("content/cms/home.body.json"),
      "content/blog/publish-from-anywhere.md": fixture("content/blog/publish-from-anywhere.md"),
    },
    devUrl: "",
  });
});

afterEach(() => site.cleanup());

/** Commits made since the fixture was set up: a publish is exactly one. */
function commits(): string[] {
  const log = execFileSync("git", ["log", "--format=%s"], { cwd: site.root, encoding: "utf8" });
  return log
    .trim()
    .split("\n")
    .filter((line) => line && line !== "initial");
}

/** Paths touched by the most recent commit. */
function commitPaths(): string[] {
  const out = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
    cwd: site.root,
    encoding: "utf8",
  });
  return out.trim().split("\n").filter(Boolean);
}

/** The head the editor form carries, which is whatever the working copy is on. */
const head = () => site.head();

function get(path: string, headers: Record<string, string> = signedIn) {
  return site.app.request(path, { headers });
}

function post(path: string, fields: Record<string, string>, headers = signedIn) {
  return site.app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("access", () => {
  it("sends anonymous visitors to sign in", async () => {
    const response = await get("/", {});
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  it("refuses a wrong password without hinting why", async () => {
    const response = await post("/sign-in", { password: "guess" }, {});
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("That did not work");
  });

  it("issues an HttpOnly session cookie on success", async () => {
    const response = await post("/sign-in", { password: PASSWORD }, {});
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("refuses cross-origin posts", async () => {
    const response = await post(
      "/sites/site-1/regions/home.hero",
      {},
      {
        ...signedIn,
        origin: "https://evil.example",
        host: "studio.local",
      },
    );
    expect(response.status).toBe(403);
  });

  it("rejects a tampered session cookie", async () => {
    const tampered = `${createSessionCookie(sessionKey(SECRET, PASSWORD)).split(";")[0]}tampered`;
    const response = await get("/", { cookie: tampered });
    expect(response.status).toBe(303);
  });
});

describe("editing a region", () => {
  it("renders a form built from the schema, filled with current content", async () => {
    const response = await get("/sites/site-1/regions/home.hero");
    expect(response.status).toBe(200);
    const { document } = new JSDOM(await response.text()).window;

    const heading = document.querySelector<HTMLInputElement>('input[name="f[heading]"]');
    expect(heading?.value).toBe("Publish from anywhere");
    expect(document.querySelector(`label[for="${heading?.id}"]`)?.textContent).toContain("Heading");
    // Head sha travels with the form so a concurrent change can be detected.
    expect(document.querySelector<HTMLInputElement>('input[name="headSha"]')?.value).toBe(head());
  });

  it("lists the site's other regions for the preview, each pointing at its own editor", async () => {
    // Only a framed preview has a page to point at.
    site.store.updateSite("site-1", {
      name: "On disk",
      devUrl: "http://localhost:5173",
      pushAfterPublish: false,
    });
    const { document } = new JSDOM(await (await get("/sites/site-1/regions/about.intro")).text())
      .window;
    site.store.updateSite("site-1", { name: "On disk", devUrl: "", pushAfterPublish: false });
    const listed = JSON.parse(document.getElementById("live-elsewhere")?.textContent ?? "[]");
    const hero = listed.find((f: { path: string }) => f.path === "f[heading]");
    expect(hero).toMatchObject({
      value: "Publish from anywhere",
      block: { id: "region:home.hero" },
      href: "/sites/site-1/regions/home.hero#f-heading",
    });
    // Not the one being edited: that form holds it already.
    expect(listed.some((f: { block: { id: string } }) => f.block.id === "region:about.intro")).toBe(
      false,
    );
  });

  it("sends pages without the templates' indentation, and leaves typed text alone", async () => {
    await post("/sites/site-1/regions/home.hero", { headSha: head(), "f[heading]": "Two  spaces" });
    const page = await (await get("/sites/site-1/regions/home.hero")).text();
    expect(page).not.toMatch(/\n[ \t]{2,}</);
    expect(page).toContain("Two  spaces");
    // Whitespace typed into a textarea or shown in a pre is content, and survives exactly.
    const kept = "<textarea>\n    indented\n\n\n  lines</textarea><pre>  a\n    b</pre>";
    expect(compact(`<div>\n    <p>x</p>\n  </div>${kept}`)).toBe(`<div>\n<p>x</p>\n</div>${kept}`);
  });

  it("shows schema defaults for a region nobody has edited", async () => {
    const response = await get("/sites/site-1/regions/about.intro");
    const { document } = new JSDOM(await response.text()).window;
    expect(document.querySelector<HTMLInputElement>('input[name="f[heading]"]')?.value).toBe(
      "About us",
    );
  });

  it("publishes one commit and reports it", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: head(),
      action: "publish",
      "f[heading]": "Edited in the studio",
      "f[subtitle]": "Still one commit",
      "f[image][src]": "/media/hero.webp",
      "f[image][alt]": "A person editing a page",
      "f[cta][href]": "/get-started",
      "f[cta][label]": "Get started",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Published as");

    expect(commits()).toHaveLength(1);
    expect(commits()[0]).toBe("content: update home.hero");

    const written = JSON.parse(site.read("content/cms/home.hero.json"));
    expect(written.heading).toBe("Edited in the studio");
    expect(written._meta.updatedBy).toBe("Owner");
    // External-ness is derived, not typed by hand.
    expect(written.cta).toEqual({ href: "/get-started", label: "Get started" });
  });

  it("writes stable, diff-friendly JSON", async () => {
    await post("/sites/site-1/regions/home.hero", {
      headSha: head(),
      "f[heading]": "Ordering",
      "f[image][src]": "/media/a.webp",
      "f[image][alt]": "Alt",
    });
    const content = site.read("content/cms/home.hero.json");
    expect(content.endsWith("}\n")).toBe(true);
    const keys = Object.keys(JSON.parse(content));
    expect(keys).toEqual(
      [...keys].toSorted(
        (a, b) => Number(a.startsWith("_")) - Number(b.startsWith("_")) || a.localeCompare(b),
      ),
    );
  });

  it("refuses to publish invalid content, and says which field is wrong", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: head(),
      "f[heading]": "",
    });

    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("Nothing was published");
    expect(commits()).toHaveLength(0);

    const { document } = new JSDOM(body).window;
    const heading = document.querySelector('input[name="f[heading]"]');
    expect(heading?.getAttribute("aria-invalid")).toBe("true");
    const describedBy = heading?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy.split(" ").at(-1) ?? "")?.textContent).toContain(
      "required",
    );
  });

  it("will not publish an image without alt text", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: head(),
      "f[heading]": "Fine",
      "f[image][src]": "/media/a.webp",
      "f[image][alt]": "",
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Alt text is empty");
    expect(commits()).toHaveLength(0);
  });

  it("refuses to overwrite work committed while the editor was open", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: "stale-sha",
      "f[heading]": "Mine",
      "f[image][src]": "/media/a.webp",
      "f[image][alt]": "Alt",
    });
    expect(response.status).toBe(409);
    expect(await response.clone().text()).toContain("moved while you were editing");
    expect(commits()).toHaveLength(0);

    // Pressing Publish again on the same form must not overwrite what changed.
    const again = await site.app.request("/sites/site-1/regions/home.hero", {
      method: "POST",
      headers: signedIn,
      body: await retryForm(response),
    });
    expect(again.status).toBe(409);
    expect(commits()).toHaveLength(0);
  });

  it("keeps what the author typed when validation fails", async () => {
    const response = await post("/sites/site-1/regions/home.hero", {
      headSha: head(),
      "f[heading]": "",
      "f[subtitle]": "Typed but not saved",
    });
    const { document } = new JSDOM(await response.text()).window;
    expect(document.querySelector<HTMLInputElement>('input[name="f[subtitle]"]')?.value).toBe(
      "Typed but not saved",
    );
  });
});

describe("block lists", () => {
  it("renders each stored block with move and remove controls", async () => {
    const response = await get("/sites/site-1/regions/home.body");
    const { document } = new JSDOM(await response.text()).window;

    expect(document.querySelectorAll("section.block")).toHaveLength(4);
    const sections = [
      ...document.querySelectorAll<HTMLDetailsElement>(".block-collapsible > details"),
    ];
    expect(sections).toHaveLength(4);
    expect(sections.every((section) => !section.open)).toBe(true);
    expect(sections[0]?.querySelector("summary")?.textContent).toContain("Section 1");
    expect(document.querySelector<HTMLButtonElement>('button[value="up:0"]')?.disabled).toBe(true);
    expect(document.querySelector('button[value="remove:1"]')).toBeTruthy();
  });

  it("adds a block without JavaScript, and without publishing", async () => {
    const response = await post("/sites/site-1/regions/home.body", {
      headSha: head(),
      action: "add",
      addType: "text",
      "f[blocks][0][_type]": "hero",
      "f[blocks][0][heading]": "Kept",
    });

    const { document } = new JSDOM(await response.text()).window;
    expect(document.querySelectorAll("section.block")).toHaveLength(2);
    const sections = document.querySelectorAll<HTMLDetailsElement>(".block-collapsible > details");
    expect(sections[0]?.open).toBe(false);
    expect(sections[1]?.open).toBe(true);
    expect(commits()).toHaveLength(0);
  });

  it("reorders blocks on the server", async () => {
    const response = await post("/sites/site-1/regions/home.body", {
      headSha: head(),
      action: "down:0",
      "f[blocks][0][_type]": "hero",
      "f[blocks][0][heading]": "First",
      "f[blocks][1][_type]": "text",
      "f[blocks][1][body]": "<p>Second</p>",
    });

    const { document } = new JSDOM(await response.text()).window;
    const headings = [...document.querySelectorAll("section.block h2")].map((h) => h.textContent);
    expect(headings).toEqual(["Text", "Hero"]);
    // The live preview reads the draft, so it shows the new order before anything is published.
    const draft = JSON.parse(site.read(".cms/draft/content/cms/home.body.json")) as {
      blocks: Array<{ _type: string }>;
    };
    expect(draft.blocks.map((block) => block._type)).toEqual(["text", "hero"]);
    expect(commits()).toHaveLength(0);
  });

  it("ignores a block type the schema does not allow", async () => {
    const response = await post("/sites/site-1/regions/home.body", {
      headSha: head(),
      action: "add",
      addType: "malicious",
      "f[blocks][0][_type]": "hero",
      "f[blocks][0][heading]": "Kept",
    });
    const { document } = new JSDOM(await response.text()).window;
    expect(document.querySelectorAll("section.block")).toHaveLength(1);
  });

  it("publishes a block list as a blocks document", async () => {
    await post("/sites/site-1/regions/home.body", {
      headSha: head(),
      action: "publish",
      "f[blocks][0][_type]": "hero",
      "f[blocks][0][heading]": "Only block",
    });

    const written = JSON.parse(site.read("content/cms/home.body.json"));
    expect(written.blocks).toEqual([{ _type: "hero", heading: "Only block" }]);
  });
});

describe("connecting a site", () => {
  it("requires a deliberate confirmation before disconnecting", async () => {
    const response = await get("/sites/site-1/settings");
    const { document } = new JSDOM(await response.text()).window;
    const disclosure = document.querySelector<HTMLDetailsElement>(".danger-confirm");

    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector("summary")?.textContent).toContain("Disconnect this site");
    expect(disclosure?.querySelector("button")?.textContent).toContain("Confirm disconnect");
  });

  it("rejects a folder with no schema, before storing anything", async () => {
    const empty = mkdtempSync(join(tmpdir(), "greatcms-empty-"));
    const store = new Store(":memory:");
    const isolated = createApp({ store, password: PASSWORD, secret: SECRET });

    const response = await isolated.request("/sites", {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Broken", path: empty }),
    });

    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).toContain("no .cms/schema.yaml");
    // The remedy reads as its own line, not run on after the problem.
    expect(new JSDOM(text).window.document.querySelector(".flash .fix")?.textContent).toBeTruthy();
    expect(store.listSites()).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it("says plainly when the folder does not exist, on the field itself", async () => {
    const response = await post("/sites", { name: "Typo", path: "/no/such/folder/anywhere" });
    const { document } = new JSDOM(await response.text()).window;

    expect(response.status).toBe(422);
    expect(document.querySelector("#path")?.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector("#path-hint-error")?.textContent).toContain("no folder");
  });
});

describe("forms on a site", () => {
  it("shows the address this site's forms post to, so nobody has to guess the id", async () => {
    const { document } = new JSDOM(await (await get("/sites/site-1")).text()).window;

    expect(document.querySelector('[aria-labelledby="forms"] pre')?.textContent).toContain(
      'action="http://localhost/f/site-1/contact"',
    );
  });

  it("uses the studio's public address behind a tunnel that sends no forwarded host", async () => {
    const tunnelled = createApp({
      store: site.store,
      password: PASSWORD,
      secret: SECRET,
      trustProxy: "cloudflare",
      publicUrl: "https://studio.example.com",
    });
    const response = await tunnelled.request("http://studio.example.com/sites/site-1", {
      headers: { ...signedIn, "x-forwarded-proto": "https" },
    });
    const { document } = new JSDOM(await response.text()).window;

    expect(document.querySelector('[aria-labelledby="forms"] pre')?.textContent).toContain(
      'action="https://studio.example.com/f/site-1/contact"',
    );
  });
});

describe("site settings", () => {
  it("changes the name and dev server without reconnecting", async () => {
    const response = await post("/sites/site-1/settings", {
      name: "Renamed",
      devUrl: "http://localhost:5173",
    });

    expect(response.status).toBe(303);
    expect(site.store.getSite("site-1")).toMatchObject({
      name: "Renamed",
      devUrl: "http://localhost:5173",
      path: site.root,
    });
  });

  it("keeps the folder, whatever the form says", async () => {
    await post("/sites/site-1/settings", { name: "Same", path: "/somewhere/else", devUrl: "" });

    expect(site.store.getSite("site-1")?.path).toBe(site.root);
  });

  it("refuses a dev server URL the browser would execute", async () => {
    const response = await post("/sites/site-1/settings", {
      name: "Acme",
      devUrl: "javascript:alert(1)",
    });

    expect(response.status).toBe(422);
    expect(site.store.getSite("site-1")?.devUrl).not.toContain("javascript");
  });

  it("is linked from the site page, where a missing dev server is noticed", async () => {
    const page = await (await get("/sites/site-1")).text();

    expect(page).toContain('href="/sites/site-1/settings"');
  });
});

describe("accessibility", () => {
  const pages = [
    ["sign in", "/sign-in"],
    ["sites", "/"],
    ["connect a site", "/sites/new"],
    ["site", "/sites/site-1"],
    ["site settings", "/sites/site-1/settings"],
    ["edit a region", "/sites/site-1/regions/home.hero"],
    ["edit a block list", "/sites/site-1/regions/home.body"],
  ] as const;

  it.each(pages)("%s has no axe violations", async (_name, path) => {
    const response = await get(path, path === "/sign-in" ? {} : signedIn);
    const dom = new JSDOM(await response.text(), { url: "https://studio.test/" });
    const { window } = dom;
    Object.assign(globalThis, { window, document: window.document, Node: window.Node });

    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });

  // The rules that check the HTML standard itself; how void elements and booleans are spelled is style, not validity.
  const validator = new HtmlValidate({
    extends: ["html-validate:standard"],
    rules: {
      "void-style": "off",
      "doctype-style": "off",
      "attribute-boolean-style": "off",
      "attribute-empty-style": "off",
      "no-trailing-whitespace": "off",
      "no-inline-style": "off",
      // A list styled without bullets loses its semantics in Safari unless the role is restated.
      "no-redundant-role": "off",
    },
  });

  it.each(pages)("%s is valid HTML", async (_name, path) => {
    const response = await get(path, path === "/sign-in" ? {} : signedIn);
    const report = await validator.validateString(await response.text());

    expect(
      report.results.flatMap((result) =>
        result.messages.map((m) => `${m.line}:${m.column} ${m.ruleId}: ${m.message}`),
      ),
    ).toEqual([]);
  });

  it("ships no JavaScript on pages that do not need it", async () => {
    const paths = ["/", "/sites/new", "/sites/site-1", "/inbox"];
    const bodies = await Promise.all(
      paths.map(async (path) => [path, await (await get(path)).text()] as const),
    );
    for (const [path, body] of bodies) {
      expect(body, path).not.toMatch(/<script/i);
    }
  });

  it("loads the visual editor only where there is rich text to edit", async () => {
    // home.hero has no richtext field; home.body allows a block that does.
    const plain = await (await get("/sites/site-1/regions/home.hero")).text();
    const rich = await (await get("/sites/site-1/regions/home.body")).text();

    expect(plain).not.toContain("/assets/editor.js");
    expect(rich).toContain("/assets/editor.js");

    // Both get the live-editing script; it is a kilobyte and does nothing without a dev server.
    expect(plain).toContain("/assets/live.js");
  });

  it("keeps a working textarea underneath the editor", async () => {
    const body = await (await get("/sites/site-1/regions/home.body")).text();
    const { document } = new JSDOM(body).window;

    // The enhancement hides this; without JavaScript it is the field, and it is always.
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea[data-richtext]");
    expect(textarea).toBeTruthy();
    expect(textarea?.name).toMatch(/^f\[blocks\]\[\d+\]\[body\]$/);
    expect(textarea?.hidden).toBe(false);
  });

  it("serves the editor bundle", async () => {
    const response = await get("/assets/editor.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect((await response.text()).length).toBeGreaterThan(1000);
  });
});

function pngBytes(width = 800, height = 600): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

async function retryForm(response: Response): Promise<FormData> {
  const dom = new JSDOM(await response.text());
  const form = dom.window.document.querySelector<HTMLFormElement>("#editor-form")!;
  const body = new FormData();
  for (const [key, value] of new dom.window.FormData(form)) {
    if (typeof value === "string") body.append(key, value);
  }
  body.set("action", "publish");
  return body;
}

describe("uploading an image", () => {
  it("keeps selected image bytes after a validation error and publishes them on retry", async () => {
    const invalid = await publishWithFile(
      new File([pngBytes()], "keep.png", { type: "image/png" }),
      { "f[heading]": "" },
    );
    expect(invalid.status).toBe(422);
    expect(commits()).toHaveLength(0);
    const document = new JSDOM(await invalid.clone().text()).window.document;
    const preview = document.querySelector(".preview-thumb img")?.getAttribute("src");
    expect(preview).toContain("/pending-media/");
    const imageResponse = await get(preview!);
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(imageResponse.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await imageResponse.arrayBuffer())).toEqual(pngBytes());
    expect((await get(preview!, {})).status).toBe(303);
    expect((await get(preview!.replace("region%3Ahome.hero", "region%3Ahome.body"))).status).toBe(
      404,
    );
    const body = await retryForm(invalid);
    expect(body.get("pendingMedia")).toBeTruthy();
    const oldToken = body.get("pendingMedia");
    body.set("f[heading]", "Corrected title");
    const response = await site.app.request("/sites/site-1/regions/home.hero", {
      method: "POST",
      headers: signedIn,
      body,
    });
    expect(response.status).toBe(200);
    expect(commits()).toHaveLength(1);
    expect(commitPaths()).toHaveLength(2);
    expect(commitPaths().some((path) => path.startsWith("public/media/keep-"))).toBe(true);
    expect((await retryForm(response)).get("pendingMedia")).toBeNull();
    expect((await get(preview!)).status).toBe(404);
    body.set("pendingMedia", oldToken!);
    const replay = await site.app.request("/sites/site-1/regions/home.hero", {
      method: "POST",
      headers: signedIn,
      body,
    });
    expect(replay.status).toBe(422);
    expect(commits()).toHaveLength(1);

    // The dead token is dropped, so the very next post from that form works again.
    const recovered = await retryForm(replay);
    expect(recovered.get("pendingMedia")).toBeNull();
    recovered.set("f[heading]", "After the images expired");
    recovered.set("headSha", site.head());
    const again = await site.app.request("/sites/site-1/regions/home.hero", {
      method: "POST",
      headers: signedIn,
      body: recovered,
    });
    expect(again.status).toBe(200);
    expect(commits()).toHaveLength(2);
  });

  it.each(
    ["region", "collection"].flatMap((kind) =>
      ["add", "down", "remove-other", "remove-image"].map((action) => ({ kind, action })),
    ),
  )(
    "retains uploads through $kind $action and commits only referenced images",
    async ({ kind, action }) => {
      site.cleanup();
      site = makeSite({
        schema: `version: 1
blocks:
  photo:
    fields:
      heading: { type: text, required: true }
      image: { type: image }
regions:
  home.sections:
    type: blocks
    allow: [photo]
collections:
  pages:
    path: content/pages
    format: json
    slug: title
    fields:
      title: { type: text, required: true }
      sections: { type: blocks, allow: [photo] }
`,
      });
      const path =
        kind === "region"
          ? "/sites/site-1/regions/home.sections"
          : "/sites/site-1/collections/pages/new";
      const list = kind === "region" ? "blocks" : "sections";
      const verb = action.startsWith("remove") ? "remove" : action;
      const index = action === "remove-other" ? 1 : 0;
      const value =
        kind === "region"
          ? verb === "add"
            ? "add"
            : `${verb}:${index}`
          : `nested:${verb}:sections${verb === "add" ? "" : `:${index}`}`;
      const body = new FormData();
      body.set("action", value);
      body.set("headSha", head());
      body.set("f[title]", "Our products");
      body.set("addType", "photo");
      body.set("nestedAdd[sections]", "photo");
      for (const i of [0, 1]) {
        body.set(`f[${list}][${i}][_type]`, "photo");
        body.set(`f[${list}][${i}][heading]`, `Photo ${i}`);
      }
      body.set(`f[${list}][0][image][alt]`, "Product photograph");
      body.set(
        `m[${list}][0][image]`,
        new File([pngBytes()], "product.png", { type: "image/png" }),
      );
      const edited = await site.app.request(path, { method: "POST", headers: signedIn, body });
      expect(edited.status).toBe(200);
      expect(commits()).toHaveLength(0);
      const publish = await retryForm(edited);
      expect(publish.get("pendingMedia")).toBeTruthy();
      for (const key of publish.keys()) {
        if (key.endsWith("[heading]") && !publish.get(key)) publish.set(key, "New section");
      }
      const response = await site.app.request(path, {
        method: "POST",
        headers: signedIn,
        body: publish,
      });
      expect(response.status).toBe(kind === "region" ? 200 : 303);
      expect(commits()).toHaveLength(1);
      expect(commitPaths()).toHaveLength(action === "remove-image" ? 1 : 2);
      if (action !== "remove-image")
        expect(commitPaths().some((file) => file.startsWith("public/media/product-"))).toBe(true);
    },
  );

  function publishWithFile(file: File, fields: Record<string, string> = {}) {
    const body = new FormData();
    body.set("headSha", head());
    body.set("action", "publish");
    body.set("f[heading]", "With a picture");
    body.set("f[image][alt]", "A described picture");
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    body.set("m[image]", file);

    return site.app.request("/sites/site-1/regions/home.hero", {
      method: "POST",
      headers: signedIn,
      body,
    });
  }

  it("commits the image and the content that references it in one commit", async () => {
    const file = new File([pngBytes()], "Hero Shot.png", { type: "image/png" });
    const response = await publishWithFile(file);

    expect(response.status).toBe(200);
    expect(commits()).toHaveLength(1);

    const paths = commitPaths();
    expect(paths).toHaveLength(2);
    expect(paths.some((path) => /^public\/media\/hero-shot-[0-9a-f]{8}\.png$/.test(path))).toBe(
      true,
    );
    expect(paths).toContain("content/cms/home.hero.json");
  });

  it("stores the dimensions it read from the file, so pages do not jump", async () => {
    await publishWithFile(new File([pngBytes(1440, 960)], "wide.png", { type: "image/png" }));

    const written = site.read("content/cms/home.hero.json");
    expect(JSON.parse(written).image).toMatchObject({ width: 1440, height: 960 });
  });

  it("keeps the alt text typed alongside the upload", async () => {
    await publishWithFile(new File([pngBytes()], "a.png", { type: "image/png" }));

    const written = site.read("content/cms/home.hero.json");
    expect(JSON.parse(written).image.alt).toBe("A described picture");
  });

  it("still refuses an upload with no alt text", async () => {
    const response = await publishWithFile(new File([pngBytes()], "a.png", { type: "image/png" }), {
      "f[image][alt]": "",
    });

    expect(response.status).toBe(422);
    expect(commits()).toHaveLength(0);
  });

  it("refuses a file that is not an image, without committing anything", async () => {
    const response = await publishWithFile(
      new File(["not an image"], "invoice.pdf", { type: "application/pdf" }),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("cannot be uploaded");
    expect(commits()).toHaveLength(0);
  });

  it("ignores an empty file input, so an unchanged image is left alone", async () => {
    const body = new FormData();
    body.set("headSha", head());
    body.set("f[heading]", "No new picture");
    body.set("f[image][src]", "/media/existing.webp");
    body.set("f[image][alt]", "Existing");
    body.set("m[image]", new File([], "", { type: "application/octet-stream" }));

    const response = await site.app.request("/sites/site-1/regions/home.hero", {
      method: "POST",
      headers: signedIn,
      body,
    });

    expect(response.status).toBe(200);
    expect(commitPaths()).toEqual(["content/cms/home.hero.json"]);
    const written = site.read("content/cms/home.hero.json");
    expect(JSON.parse(written).image.src).toBe("/media/existing.webp");
  });

  it("offers a file input on the edit form, in a multipart form", async () => {
    const body = await (await get("/sites/site-1/regions/home.hero")).text();
    const { document } = new JSDOM(body).window;

    const form = document.querySelector("form[action*='regions']");
    expect(form?.getAttribute("enctype")).toBe("multipart/form-data");

    const fileInput = document.querySelector<HTMLInputElement>('input[name="m[image]"]');
    expect(fileInput?.type).toBe("file");
    expect(document.querySelector(`label[for="${fileInput?.id}"]`)).toBeTruthy();
  });
});

describe("uploading an image with a collection entry", () => {
  it("commits the product and its image together", async () => {
    site.cleanup();
    site = makeSite({
      schema: `version: 1
collections:
  products:
    path: content/products
    format: json
    slug: name
    fields:
      name: { type: text, required: true }
      description: { type: text, required: true }
      image: { type: image, required: true }
`,
    });

    const body = new FormData();
    body.set("action", "publish");
    body.set("f[name]", "Lake fish");
    body.set("f[description]", "Fresh from the lake");
    body.set("f[image][alt]", "A basket of fresh fish");
    body.set("m[image]", new File([pngBytes(800, 600)], "Lake Fish.png", { type: "image/png" }));

    const response = await site.app.request("/sites/site-1/collections/products/new", {
      method: "POST",
      headers: signedIn,
      body,
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sites/site-1/collections/products/lake-fish");
    expect(commitPaths()).toHaveLength(2);
    expect(commitPaths()).toContain("content/products/lake-fish.json");
    expect(
      commitPaths().some((path) => /^public\/media\/lake-fish-[0-9a-f]{8}\.png$/.test(path)),
    ).toBe(true);
    expect(JSON.parse(site.read("content/products/lake-fish.json")).image).toMatchObject({
      alt: "A basket of fresh fish",
      width: 800,
      height: 600,
    });
  });
});

describe("editing a collection", () => {
  it("uses a collection's own noun and slug field throughout the add flow", async () => {
    site.cleanup();
    site = makeSite({
      schema: `version: 1
collections:
  products:
    label: Products
    entryLabel: product
    path: content/products
    format: json
    slug: name
    fields:
      name: { type: text, required: true }
      description: { type: text }
`,
      files: {
        "content/products/lake-fish.json": JSON.stringify({
          name: "Lake fish",
          description: "Fresh from the lake",
        }),
      },
    });

    const dashboard = await (await get("/sites/site-1")).text();
    expect(dashboard).toContain("Add product");
    expect(dashboard).toContain("/sites/site-1/collections/products/new");

    const list = await (await get("/sites/site-1/collections/products")).text();
    expect(list).toContain("Lake fish");
    expect(list).toContain("Fresh from the lake");
    expect(list).toContain("Add product");

    const add = await (await get("/sites/site-1/collections/products/new")).text();
    expect(add).toContain("New product");
    expect(add).not.toContain("New Products entry");
  });

  it("lists entries from the repository", async () => {
    site.write(
      "content/blog/first-post.md",
      "---\ntitle: First post\ndate: 2026-08-01\n---\n\nHello.\n",
    );
    site.write(
      "content/blog/second-post.md",
      "---\ntitle: Second post\ndate: 2026-08-02\n---\n\nAgain.\n",
    );

    const response = await get("/sites/site-1/collections/blog");
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("First post");
    expect(body).toContain("Second post");
  });

  it("opens an entry with its stored values in the form", async () => {
    site.write(
      "content/blog/first-post.md",
      "---\ntitle: First post\ndate: 2026-08-01\n---\n\nThe body text.\n",
    );

    const { document } = new JSDOM(
      await (await get("/sites/site-1/collections/blog/first-post")).text(),
    ).window;

    expect(document.querySelector<HTMLInputElement>('input[name="f[title]"]')?.value).toBe(
      "First post",
    );
    const form = document.querySelector("#editor-form");
    const actions = form?.querySelector(".form-actions");
    const firstField = form?.querySelector(".field");
    expect(actions?.nextElementSibling).toBe(firstField);
    // The Markdown body is a normal field as far as the editor is concerned.
    expect(document.querySelector("textarea")?.textContent).toContain("The body text.");
  });

  it("links to an entry whose file name needs escaping in a URL", async () => {
    site.cleanup();
    site = makeSite({
      schema: fixture(".cms/schema.yaml"),
      config: fixture(".cms/config.yaml"),
      files: {
        "content/blog/q&a #1?.md": "---\ntitle: Questions\ndate: 2026-10-03\n---\n\nAnswers.\n",
      },
      devUrl: "",
    });

    const list = new JSDOM(await (await get("/sites/site-1/collections/blog")).text()).window
      .document;
    const href = [...list.querySelectorAll("a")]
      .map((a) => a.getAttribute("href") ?? "")
      .find((link) => link.includes("q%26a"));
    expect(href).toBe("/sites/site-1/collections/blog/q%26a%20%231%3F");

    const entry = await get(href!);
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain("Answers.");
  });

  it("refuses a new entry whose file name is already taken", async () => {
    const before = site.read("content/blog/publish-from-anywhere.md");

    const response = await post("/sites/site-1/collections/blog/new", {
      headSha: head(),
      "f[title]": "Publish from anywhere",
      "f[date]": "2026-10-02",
      "f[content]": "A different body.",
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("already taken");
    expect(site.read("content/blog/publish-from-anywhere.md")).toBe(before);
    expect(commits()).toHaveLength(0);
  });

  it("refuses a title that would become the create route", async () => {
    const response = await post("/sites/site-1/collections/blog/new", {
      headSha: head(),
      "f[title]": "New",
      "f[date]": "2026-10-02",
    });

    expect(response.status).toBe(409);
    expect(site.exists("content/blog/new.md")).toBe(false);
    expect(commits()).toHaveLength(0);
  });

  it("publishes a new entry as Markdown with frontmatter", async () => {
    const response = await post("/sites/site-1/collections/blog/new", {
      headSha: head(),
      "f[title]": "A brand new post",
      "f[date]": "2026-08-13",
      "f[content]": "Some words in the body.",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/sites/site-1/collections/blog/a-brand-new-post",
    );
    expect(commits()).toHaveLength(1);

    // The file name is derived from the title via the schema's slug field.
    expect(commitPaths()).toEqual(["content/blog/a-brand-new-post.md"]);

    const content = site.read("content/blog/a-brand-new-post.md");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("title: A brand new post");
    expect(content).toContain("Some words in the body.");
    // The body lives in the body, not duplicated into frontmatter.
    expect(content).not.toContain("content: Some words");
  });

  it("keeps an existing entry's file name when its title changes", async () => {
    site.write(
      "content/blog/first-post.md",
      "---\ntitle: First post\ndate: 2026-08-01\n---\n\nBody.\n",
    );

    await post("/sites/site-1/collections/blog/first-post", {
      headSha: head(),
      "f[title]": "A completely different title",
      "f[date]": "2026-08-01",
      "f[content]": "Body.",
    });

    // Renaming a title must not orphan a published URL.
    expect(commitPaths()).toEqual(["content/blog/first-post.md"]);
  });

  it("refuses an invalid entry, naming the field", async () => {
    const response = await post("/sites/site-1/collections/blog/new", {
      headSha: head(),
      "f[title]": "",
      "f[date]": "2026-08-13",
    });

    expect(response.status).toBe(422);
    expect(commits()).toHaveLength(0);
    expect(await response.text()).toContain("not valid yet");
  });

  it("deletes an entry in one commit", async () => {
    site.commit("content/blog/first-post.md", "---\ntitle: First post\n---\n\nBody.\n");

    const response = await site.app.request("/sites/site-1/collections/blog/first-post/delete", {
      method: "POST",
      headers: signedIn,
    });

    expect(response.status).toBe(303);
    expect(commitPaths()).toEqual(["content/blog/first-post.md"]);
    expect(site.exists("content/blog/first-post.md")).toBe(false);
  });

  it("links collections from the site page, so they are findable", async () => {
    const body = await (await get("/sites/site-1")).text();
    expect(body).toContain("/sites/site-1/collections/blog");
  });

  it("has no axe violations on the entry form", async () => {
    site.write("content/blog/first-post.md", "---\ntitle: First post\n---\n\nBody.\n");
    const response = await get("/sites/site-1/collections/blog/first-post");
    const { window } = new JSDOM(await response.text(), { url: "https://studio.test/" });
    Object.assign(globalThis, { window, document: window.document, Node: window.Node });

    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("the live view of your site", () => {
  it("shows no frame without a dev server, and says where to add one", async () => {
    const { document } = new JSDOM(await (await get("/sites/site-1/regions/home.hero")).text())
      .window;

    expect(document.querySelector("iframe[data-live-site]")).toBeNull();
    expect(document.querySelector('.live a[href="/sites/site-1/settings"]')?.textContent).toContain(
      "dev server",
    );
  });

  it("labels the rows of a list, rather than numbering them from zero", async () => {
    site.cleanup();
    site = makeSite({
      schema: `version: 1
regions:
  home.facts:
    fields:
      facts: { type: list, label: Facts, of: { type: text } }
`,
      files: { "content/cms/home.facts.json": '{ "facts": ["Fast"] }\n' },
      devUrl: "",
    });
    const { document } = new JSDOM(await (await get("/sites/site-1/regions/home.facts")).text())
      .window;
    const labels = [...document.querySelectorAll("fieldset label")].map((l) =>
      l.textContent?.trim(),
    );

    expect(labels).toEqual(["Item 1", "New item"]);
  });

  it("writes a draft without committing anything", async () => {
    const response = await post("/sites/site-1/regions/home.hero/draft", {
      "f[heading]": "Typed but never saved",
    });

    expect(response.status).toBe(204);
    expect(site.read(".cms/draft/content/cms/home.hero.json")).toContain("Typed but never saved");
    expect(commits()).toHaveLength(0);
  });

  it("restores an unsaved edit into the editor, and says so", async () => {
    await post("/sites/site-1/regions/home.hero/draft", { "f[heading]": "Typed but never saved" });
    const body = await (await get("/sites/site-1/regions/home.hero")).text();

    expect(body).toContain('value="Typed but never saved"');
    expect(body).toContain("This form holds unsaved edits");
    expect(body).toContain('action="/sites/site-1/regions/home.hero/draft/discard"');
  });

  it("shows what is published once the draft is discarded", async () => {
    await post("/sites/site-1/regions/home.hero/draft", { "f[heading]": "Typed but never saved" });
    await post("/sites/site-1/regions/home.hero/draft/discard", {});
    const body = await (await get("/sites/site-1/regions/home.hero")).text();

    expect(body).not.toContain("Typed but never saved");
    expect(body).not.toContain("This form holds unsaved edits");
  });

  it("serves the live-editing and conditional-field bundles", async () => {
    expect((await get("/assets/live.js")).status).toBe(200);
    expect((await get("/assets/form.js")).status).toBe(200);
    expect((await get("/assets/shell.js")).status).toBe(200);
  });

  it("serves the stylesheet as a file the browser can keep, and before sign-in", async () => {
    const signIn = await (await get("/sign-in", {})).text();
    const href = /href="(\/assets\/studio\.css\?v=[0-9a-f]+)"/.exec(signIn)?.[1];
    expect(href, "the sign-in page links a versioned stylesheet").toBeDefined();
    expect(signIn).not.toContain("<style");

    const pinned = await get(href!, {});
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("content-type")).toContain("text/css");
    expect(pinned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    // Without the version the content could change under a long cache, so it does not get one.
    expect((await get("/assets/studio.css", {})).headers.get("cache-control")).toBe(
      "public, max-age=300",
    );
  });

  it("compresses what it serves when the browser asks", async () => {
    const gz = await get("/assets/editor.js", { ...signedIn, "accept-encoding": "gzip" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect((await gz.arrayBuffer()).byteLength).toBeLessThan(
      (await (await get("/assets/editor.js")).arrayBuffer()).byteLength / 2,
    );
  });

  it("refuses to serve anything else from the asset route", async () => {
    expect((await get("/assets/../src/db.ts")).status).toBe(404);
    expect((await get("/assets/secrets.js")).status).toBe(404);
  });
});
