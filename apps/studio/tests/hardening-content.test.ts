/** Untrusted repository content must stay data, inside the site and outside executable contexts. */

import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@greatcms/spec";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { MAX_BYTES, prepareUpload, UploadError } from "../src/media.js";
import { LocalRepository } from "../src/repo.js";
import { sanitizeRichText } from "../src/sanitize.js";
import { SiteClient } from "../src/sites.js";
import { WebhookNotifier } from "../src/submissions.js";
import {
  get,
  makeSite,
  PASSWORD,
  post,
  SECRET,
  signedIn,
  SITE_ID,
  type Fixture,
  type FixtureOptions,
} from "./site.js";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", () => ({ connect }));

const schema = JSON.stringify({
  version: 1,
  regions: { "home.hero": { fields: { heading: { type: "text" }, image: { type: "image" } } } },
  collections: {
    blog: { path: "content/blog", format: "json", fields: { title: { type: "text" } } },
  },
});
const sites: Fixture[] = [];
const outside: string[] = [];
const regionUrl = "/sites/site-1/regions/home.hero";
const collectionUrl = "/sites/site-1/collections/blog";
const badPaths = [
  "../escape",
  "ordinary..name",
  "/tmp/escape",
  "folder/../escape",
  "folder\\escape",
  "%2e%2e%2fescape",
  "folder%2fescape",
  "folder%5cescape",
  "bad\0name",
  "bad%00name",
];
/** Folders that are only odd names on disk: `%2f` is three characters, nothing decodes it. */
const literalOnDisk = new Set([
  "%2e%2e%2fescape",
  "folder%2fescape",
  "folder%5cescape",
  "bad%00name",
]);
const badFolders = badPaths.filter((path) => !literalOnDisk.has(path));
/** One segment that merely contains two dots is a name, not a way up. */
const badSlugs = badPaths.filter((slug) => slug !== "ordinary..name");

function fixture(options: Partial<FixtureOptions> = {}): Fixture {
  const site = makeSite({ schema, git: false, ...options });
  sites.push(site);
  return site;
}

function client(site: Fixture): SiteClient {
  return new SiteClient(site.store.getSite(SITE_ID)!);
}

function externalFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "greatcms-untrusted-"));
  outside.push(root);
  return root;
}

function document(html: string): Document {
  return new JSDOM(html).window.document;
}

function escaped(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function expectEscaped(html: string, values: string[]): void {
  for (const value of values) {
    expect.soft(html).toContain(escaped(value));
    expect.soft(html).not.toContain(value);
  }
  expect(document(html).querySelector("[data-attack]")).toBeNull();
}

const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
);

async function upload(
  site: Fixture,
  name: string,
  type: string,
  bytes: Uint8Array,
): Promise<Response> {
  const body = new FormData();
  body.set("f[heading]", "Uploaded");
  body.set("f[image][alt]", "A test image");
  body.set("m[image]", new File([new Uint8Array(bytes)], name, { type }));
  return site.app.request(regionUrl, { method: "POST", headers: signedIn, body });
}

beforeEach(() => {
  connect.mockReset();
  connect.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
});

afterEach(() => {
  for (const site of sites.splice(0)) {
    site.store.close();
    site.cleanup();
  }
  for (const root of outside.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("repository path boundaries", () => {
  it.each(badPaths)("refuses region id %j from schema", async (id) => {
    const site = fixture({
      schema: JSON.stringify({
        version: 1,
        regions: { [id]: { fields: { text: { type: "text" } } } },
      }),
    });
    await expect(client(site).context()).rejects.toThrow();
  });

  it.each(badPaths)("refuses collection name %j from schema", async (name) => {
    const site = fixture({
      schema: JSON.stringify({
        version: 1,
        collections: { [name]: { path: "content/blog", fields: { title: { type: "text" } } } },
      }),
    });
    await expect(client(site).context()).rejects.toThrow();
  });

  it.each(badSlugs)("refuses entry slug %j for reads, writes and deletes", async (slug) => {
    const site = fixture();
    const url = `${collectionUrl}/${encodeURIComponent(slug)}`;
    const responses = await Promise.all([
      get(site, url),
      post(site, url, { "f[title]": "Changed" }),
      post(site, `${url}/delete`, {}),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(site.exists("content/blog/escape.json")).toBe(false);
  });

  it.each(badPaths)("refuses media file name %j on the serving route", async (name) => {
    const site = fixture();
    expect((await get(site, `/sites/site-1/media/${encodeURIComponent(name)}.png`)).status).toBe(
      404,
    );
  });

  it.each(["regions", "media"].flatMap((key) => badFolders.map((path) => ({ key, path }))))(
    "refuses content.$key path $path",
    async ({ key, path }) => {
      const site = fixture();
      site.write(".cms/config.yaml", JSON.stringify({ version: 1, content: { [key]: path } }));
      await expect(client(site).context()).rejects.toThrow();
    },
  );

  it.each(badFolders)("refuses collection storage path %j from schema", async (path) => {
    const site = fixture({
      schema: JSON.stringify({
        version: 1,
        collections: { blog: { path, fields: { title: { type: "text" } } } },
      }),
    });
    await expect(client(site).context()).rejects.toThrow();
  });

  it("refuses a lexical escape on repository reads and writes", async () => {
    const site = fixture();
    const root = externalFolder();
    const target = join(root, "sentinel.json");
    writeFileSync(target, "outside");
    const repo = new LocalRepository(site.root);
    expect(await repo.getFile(target)).toBeNull();
    await expect(
      repo.commitFiles({ message: "escape", files: [{ path: target, content: "changed" }] }),
    ).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("outside");
  });

  it("does not read content or media through an external symbolic link", async () => {
    const site = fixture();
    const root = externalFolder();
    writeFileSync(join(root, "sentinel.json"), JSON.stringify({ heading: "EXTERNAL_SECRET" }));
    writeFileSync(join(root, "secret.png"), png);
    mkdirSync(join(site.root, "content/cms"), { recursive: true });
    mkdirSync(join(site.root, "public/media"), { recursive: true });
    symlinkSync(join(root, "sentinel.json"), join(site.root, "content/cms/home.hero.json"));
    symlinkSync(join(root, "secret.png"), join(site.root, "public/media/secret.png"));
    const response = await get(site, regionUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("EXTERNAL_SECRET");
    expect((await get(site, "/sites/site-1/media/secret.png")).status).toBe(404);
  });

  it("does not list an external directory through a symbolic link", async () => {
    const site = fixture();
    const root = externalFolder();
    writeFileSync(join(root, "secret.json"), "{}");
    symlinkSync(root, join(site.root, "linked"));
    expect(await new LocalRepository(site.root).listDirectory("linked")).toEqual([]);
  });

  it.each(["file", "directory"])(
    "refuses writes and deletes through an external %s link",
    async (kind) => {
      const site = fixture();
      const root = externalFolder();
      writeFileSync(join(root, "sentinel.json"), "outside");
      const path = kind === "file" ? "linked.json" : "linked/sentinel.json";
      symlinkSync(
        kind === "file" ? join(root, "sentinel.json") : root,
        join(site.root, kind === "file" ? "linked.json" : "linked"),
      );
      const repo = new LocalRepository(site.root);
      await expect(
        repo.commitFiles({ message: "escape", files: [{ path, content: "changed" }] }),
      ).rejects.toThrow();
      await expect(
        repo.commitFiles({ message: "escape", files: [{ path, delete: true }] }),
      ).rejects.toThrow();
      expect(readFileSync(join(root, "sentinel.json"), "utf8")).toBe("outside");
    },
  );

  it("does not create outside directories before rejecting a linked write", async () => {
    const site = fixture();
    const root = externalFolder();
    symlinkSync(root, join(site.root, "linked"));
    await expect(
      new LocalRepository(site.root).commitFiles({
        message: "escape",
        files: [{ path: "linked/new/folder/file.json", content: "changed" }],
      }),
    ).rejects.toThrow();
    expect(existsSync(join(root, "new"))).toBe(false);
  });

  it.each([".cms/schema.yaml", ".cms/config.yaml"])(
    "does not read %s through an external link",
    async (path) => {
      const site = fixture();
      const root = externalFolder();
      writeFileSync(
        join(root, "file"),
        path.includes("schema") ? schema : "version: 1\ncontent: { regions: external-secret }\n",
      );
      rmSync(join(site.root, path));
      symlinkSync(join(root, "file"), join(site.root, path));
      if (path.includes("schema")) await expect(client(site).context()).rejects.toThrow();
      else
        expect((await client(site).context()).config.content.regions).toBe(
          DEFAULT_CONFIG.content.regions,
        );
    },
  );
});

describe("image upload validation", () => {
  it.each([
    ["script.svg", "image/svg+xml", "<svg><script>alert(1)</script></svg>"],
    ["page.html", "text/html", "<html><script>alert(1)</script></html>"],
    ["forged.png", "image/png", "<svg onload=alert(1)></svg>"],
    ["forged.png", "image/png", "<html><img src=x onerror=alert(1)></html>"],
  ])("refuses document upload %s declared as %s", async (name, type, text) => {
    const site = fixture();
    expect((await upload(site, name, type, new TextEncoder().encode(text))).status).toBe(422);
    expect(site.exists("content/cms/home.hero.json")).toBe(false);
    expect(site.store.pendingMediaFile(SITE_ID, "region:home.hero", "missing", 0)).toBeNull();
  });

  it("refuses bytes that disagree with the declared MIME type", async () => {
    expect((await upload(fixture(), "photo.jpg", "image/jpeg", png)).status).toBe(422);
  });

  it.each(["photo.jpg", "page.html", "script.svg"])(
    "stores %s under the extension of the PNG it really is",
    async (name) => {
      const site = fixture();
      expect((await upload(site, name, "image/png", png)).status).toBe(200);
      const stored = JSON.parse(site.read("content/cms/home.hero.json"));
      // The name a browser sent is a hint; the bytes decide what is served, and as what.
      expect(stored.image.src).toMatch(/\.png$/);
    },
  );

  it("normalises an accepted filename and commits the matching image bytes", async () => {
    const site = fixture();
    const response = await upload(site, "../../Héro <image> \\ test.PNG", "image/png", png);
    expect(response.status).toBe(200);
    const stored = JSON.parse(site.read("content/cms/home.hero.json"));
    expect(stored.image.src).toMatch(/^\/media\/hero-image-test-[a-f0-9]{8}\.png$/);
    expect(readFileSync(join(site.root, "public", stored.image.src))).toEqual(Buffer.from(png));
    expect(
      (await get(site, `/sites/site-1/media/${stored.image.src.split("/").pop()}`)).headers.get(
        "content-type",
      ),
    ).toBe("image/png");
  });

  it("enforces the byte limit, including its exact boundary", () => {
    const bytes = new Uint8Array(MAX_BYTES);
    bytes.set(png);
    expect(() =>
      prepareUpload(DEFAULT_CONFIG, { fileName: "limit.png", type: "image/png", bytes }),
    ).not.toThrow();
    expect(() =>
      prepareUpload(DEFAULT_CONFIG, {
        fileName: "large.png",
        type: "image/png",
        bytes: new Uint8Array(MAX_BYTES + 1),
      }),
    ).toThrow(UploadError);
    expect(() =>
      prepareUpload(DEFAULT_CONFIG, {
        fileName: "empty.png",
        type: "image/png",
        bytes: new Uint8Array(),
      }),
    ).toThrow(UploadError);
  });

  it("rejects an oversized multipart image before publishing content", async () => {
    const site = fixture();
    const bytes = new Uint8Array(MAX_BYTES + 1);
    bytes.set(png);
    expect([413, 422]).toContain((await upload(site, "large.png", "image/png", bytes)).status);
    expect(site.exists("content/cms/home.hero.json")).toBe(false);
  });
});

describe("rich text sanitizer", () => {
  const attacks = [
    "<script>alert(1)</script><style>body{display:none}</style><p>safe</p>",
    '<p onclick="alert(1)"><img src="/ok.png" onerror="alert(1)"></p>',
    '<a href="javascript:alert(1)">click</a>',
    '<a href="JaVaScRiPt:alert(1)">click</a>',
    '<a href="java&#x09;script:alert(1)">click</a>',
    '<a href="&#106;avascript&#58;alert(1)">click</a>',
    '<a href="vbscript:msgbox(1)">click</a>',
    '<a href="data:text/html,<script>alert(1)</script>">click</a>',
    '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
    '<img src="data:image/png;base64,aGVsbG8=">',
    "<svg><foreignObject><p onmouseover=alert(1)>x</p></foreignObject></svg>",
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<p><strong><em>x</p></strong><img src="javascript:alert(1)" onload=alert(1)>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="javascript:alert(1)"></object>',
    '<a href="https://safe.example/" onmouseover=alert(1)"><b>safe</b></a>',
    '<p title="</p><script>alert(1)</script>">safe &lt;script&gt;</p>',
    `${"<blockquote>".repeat(200)}safe${"</blockquote>".repeat(200)}<script>x</script>`,
  ];

  it.each(attacks.map((input, index) => ({ input, index })))(
    "removes executable markup from case $index",
    ({ input }) => {
      const output = sanitizeRichText(input);
      const parsed = document(output);
      expect(parsed.querySelector("script,style,iframe,object,embed,svg,math,template")).toBeNull();
      for (const element of parsed.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          expect(attribute.name).not.toMatch(/^on/i);
          if (["href", "src"].includes(attribute.name)) {
            const value = [...attribute.value]
              .filter((char) => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127)
              .join("")
              .toLowerCase();
            expect(value).not.toMatch(/^(javascript|vbscript|data):/);
          }
        }
      }
      expect(sanitizeRichText(output)).toBe(output);
    },
  );

  it("preserves ordinary formatting and HTTPS links", () => {
    expect(
      sanitizeRichText(
        '<p><strong>Safe</strong> <a href="https://example.com">link</a><img src="/image.png" alt="test"></p>',
      ),
    ).toBe(
      '<p><strong>Safe</strong> <a href="https://example.com">link</a><img src="/image.png" alt="test"></p>',
    );
  });
});

const markup = (label: string) => `<img data-attack="${label}" src=x onerror=alert(1)>`;
const labels = {
  site: markup("site"),
  region: markup("region"),
  field: markup("field"),
  description: markup("description"),
  collection: markup("collection"),
  value: `needle ${markup("value")}`,
};

function hostileSite(): Fixture {
  const site = fixture({
    git: true,
    schema: JSON.stringify({
      version: 1,
      site: { name: labels.site },
      regions: {
        "home.hero": {
          label: labels.region,
          fields: {
            heading: { type: "text", label: labels.field, description: labels.description },
            required: { type: "text", required: true },
            body: { type: "richtext" },
          },
        },
      },
      collections: {
        blog: {
          label: labels.collection,
          description: labels.description,
          path: "content/blog",
          format: "json",
          fields: { title: { type: "text", label: labels.field, description: labels.description } },
        },
      },
    }),
    files: {
      "content/cms/home.hero.json": JSON.stringify({
        heading: labels.value,
        body: { html: '</textarea><img data-attack="richtext" src=x onerror=alert(1)>' },
      }),
      "content/blog/entry.json": JSON.stringify({ title: labels.value }),
    },
  });
  site.store.updateSite(SITE_ID, { name: labels.site, devUrl: "", pushAfterPublish: false });
  return site;
}

describe("escaping text from files and editors", () => {
  it("escapes site names on the site list", async () => {
    const site = hostileSite();
    site.store.addSite({
      id: "site-2",
      name: "Another site",
      path: externalFolder(),
      devUrl: "",
      createdAt: "2026-11-04",
    });
    const response = await get(site, "/");
    expect(response.status).toBe(200);
    expectEscaped(await response.text(), [labels.site]);
  });

  it.each([
    [regionUrl, [labels.site, labels.region, labels.field, labels.description, labels.value]],
    [collectionUrl, [labels.site, labels.collection, labels.value]],
    [
      `${collectionUrl}/entry`,
      [labels.site, labels.collection, labels.field, labels.description, labels.value],
    ],
    ["/sites/site-1/settings", [labels.site]],
    ["/sites/site-1", [labels.site, labels.region, labels.collection]],
  ] as const)("escapes schema and stored text on %s", async (path, expected) => {
    const response = await get(hostileSite(), path);
    expect(response.status).toBe(200);
    expectEscaped(await response.text(), [...expected]);
  });

  it("escapes editor values when an invalid form is rendered again", async () => {
    const response = await post(hostileSite(), regionUrl, { "f[heading]": labels.value });
    expect(response.status).toBe(422);
    expectEscaped(await response.text(), [labels.value, labels.field, labels.description]);
  });

  it("escapes commit messages on history and recent activity", async () => {
    const site = hostileSite();
    const message = markup("commit");
    site.write("content/cms/home.hero.json", JSON.stringify({ heading: "Changed" }));
    site.git(["add", "--", "content/cms/home.hero.json"]);
    site.git(["commit", "-qm", message]);
    const pages = await Promise.all([
      get(site, `${regionUrl}/history`),
      get(site, "/sites/site-1"),
    ]);
    expect(pages.map((response) => response.status)).toEqual([200, 200]);
    const texts = await Promise.all(pages.map((response) => response.text()));
    for (const text of texts) expectEscaped(text, [message]);
  });

  it("escapes search labels, query and entity-decoded result text", async () => {
    const site = hostileSite();
    site.write(
      "content/blog/entry.json",
      JSON.stringify({
        title: `needle &lt;img data-attack=&quot;search&quot; src=x onerror=alert(1)&gt;`,
      }),
    );
    const response = await get(site, "/sites/site-1/search?q=needle");
    expect(response.status).toBe(200);
    expectEscaped(await response.text(), [
      labels.region,
      labels.collection,
      labels.field,
      markup("search"),
    ]);
    const query = markup("query");
    const queryResponse = await get(site, `/sites/site-1/search?q=${encodeURIComponent(query)}`);
    expect(queryResponse.status).toBe(200);
    expectEscaped(await queryResponse.text(), [query]);
  });

  it("escapes submitted field names, values and form names in the inbox", async () => {
    const site = hostileSite();
    const key = markup("submission-key");
    const value = markup("submission-value");
    const form = markup("form");
    const response = await post(
      site,
      `/f/site-1/${encodeURIComponent(form)}`,
      { [key]: value },
      {},
    );
    expect(response.status).toBe(200);
    expect(site.store.listSubmissions({})).toHaveLength(1);
    const inbox = await get(site, "/inbox?spam=1");
    expect(inbox.status).toBe(200);
    expectEscaped(await inbox.text(), [labels.site, key, value, form]);
  });
});

describe("git arguments remain data", () => {
  it("publishes leading-option messages and paths literally, ignoring the obsolete branch setting", async () => {
    const site = fixture({
      git: true,
      config: JSON.stringify({
        version: 1,
        content: { regions: "--output=owned" },
        publish: { branch: "--help", commitMessage: "--help {summary}" },
      }),
    });
    const response = await post(site, regionUrl, { "f[heading]": "Safe" });
    expect(response.status).toBe(200);
    expect(site.read("--output=owned/home.hero.json")).toContain("Safe");
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: site.root, encoding: "utf8" }).trim();
    expect(git(["log", "-1", "--format=%s"])).toBe("--help home.hero");
    expect(git(["branch", "--show-current"])).toBe("main");
    expect(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe(
      "--output=owned/home.hero.json",
    );
  });

  it.each(["--help", "--output=owned", "-n1", "HEAD", "HEAD~1", "main:content/cms/home.hero.json"])(
    "refuses rollback and restore revision %j",
    async (sha) => {
      const site = fixture({ git: true });
      const head = site.head();
      expect(
        (await post(site, `${regionUrl}/history/${encodeURIComponent(sha)}/restore`, {})).status,
      ).toBe(404);
      expect((await post(site, "/sites/site-1/rollback", { sha })).status).toBe(404);
      expect(site.head()).toBe(head);
      expect(site.exists(".cms/draft/content/cms/home.hero.json")).toBe(false);
      expect(site.exists("owned")).toBe(false);
    },
  );

  it("restores a real commit into a draft", async () => {
    const site = fixture({
      git: true,
      files: { "content/cms/home.hero.json": JSON.stringify({ heading: "Earlier" }) },
    });
    const sha = site.head();
    expect((await post(site, `${regionUrl}/history/${sha}/restore`, {})).status).toBe(303);
    expect(site.read(".cms/draft/content/cms/home.hero.json")).toContain("Earlier");
    expect(site.head()).toBe(sha);
  });
});

describe("URL schemes at frame and network boundaries", () => {
  const unsafeUrls = [
    "javascript:alert(1)",
    "data:text/html,test",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/file",
    "//example.com/path",
  ];

  it.each(unsafeUrls)("refuses devUrl %j on create and settings", async (devUrl) => {
    const site = fixture();
    const responses = await Promise.all([
      post(site, "/sites", { name: "Bad", path: site.root, devUrl }),
      post(site, "/sites/site-1/settings", { name: "Example", devUrl }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([422, 422]);
    expect(site.store.getSite(SITE_ID)!.devUrl).toBe("");
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(unsafeUrls)("does not connect to probe URL %j", async (url) => {
    const site = fixture();
    const app = createApp({
      store: site.store,
      password: PASSWORD,
      secret: SECRET,
      probeUrls: new Map([[SITE_ID, url]]),
    });
    expect((await app.request(regionUrl, { headers: signedIn })).status).toBe(200);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(unsafeUrls)("does not send a webhook to %j", async (url) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await new WebhookNotifier(url, fetchImpl).notify({
      kind: "publish",
      subject: "test",
      lines: ["test"],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["http://preview.example:4321", "https://preview.example"])(
    "allows HTTP(S) dev, probe and webhook URL %s",
    async (url) => {
      const site = fixture();
      expect(
        (await post(site, "/sites/site-1/settings", { name: "Example", devUrl: url })).status,
      ).toBe(303);
      expect((await get(site, regionUrl)).status).toBe(200);
      expect(connect).toHaveBeenCalled();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 }));
      await new WebhookNotifier(url, fetchImpl).notify({
        kind: "publish",
        subject: "test",
        lines: [],
      });
      expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ method: "POST" }));
    },
  );

  it.each(["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd"])(
    "refuses schema-configured preview URL %j",
    async (url) => {
      const site = fixture({
        devUrl: "https://preview.example",
        config: JSON.stringify({ version: 1, preview: { paths: { blog: url } } }),
        files: { "content/blog/entry.json": '{"title":"Entry"}' },
      });
      const response = await get(site, `${collectionUrl}/entry`);
      expect(response.status).toBe(200);
      const parsed = document(await response.text());
      for (const frame of parsed.querySelectorAll("iframe[src]")) {
        expect(new URL(frame.getAttribute("src")!, "https://studio.example").protocol).toMatch(
          /^https?:$/,
        );
      }
      for (const element of parsed.querySelectorAll("[data-preview-url]")) {
        expect(
          new URL(element.getAttribute("data-preview-url")!, "https://studio.example").protocol,
        ).toMatch(/^https?:$/);
      }
      expect(parsed.querySelector(`a[href^="${url.split(":")[0]}:"]`)).toBeNull();
    },
  );
});

describe("bounded schema work", () => {
  it("finishes pathological pattern validation within 500 ms", async () => {
    const site = fixture({
      schema: JSON.stringify({
        version: 1,
        regions: { "home.hero": { fields: { heading: { type: "text", pattern: "^(a+)+$" } } } },
      }),
    });
    // Bounded input makes the vulnerable case finish even without a regex execution limit.
    const start = performance.now();
    const response = await post(site, regionUrl, { "f[heading]": `${"a".repeat(26)}!` });
    const elapsed = performance.now() - start;
    expect([422, 502]).toContain(response.status);
    expect(elapsed).toBeLessThan(500);
  });

  it("finishes 1000 nested schema groups within 1000 ms", async () => {
    let field: Record<string, unknown> = { type: "text" };
    for (let depth = 0; depth < 1000; depth += 1)
      field = { type: "group", fields: { nested: field } };
    const site = fixture({
      schema: JSON.stringify({ version: 1, regions: { "home.hero": { fields: { root: field } } } }),
    });
    const start = performance.now();
    const response = await get(site, regionUrl);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect([200, 422, 502]).toContain(response.status);
  });
});
