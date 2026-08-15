/** MDX collections: prose with components in it, which a WYSIWYG editor would eat. */

import { entryExtension, hasFrontmatter, parseSchema } from "@greatcms/spec";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createSessionCookie, sessionKey } from "../src/auth.js";
import { Store } from "../src/db.js";
import { clearContextCache } from "../src/sites.js";

const PASSWORD = "mdx-password";
const SECRET = "mdx-secret";
const SITE = {
  id: "site-1",
  name: "Docs",
  owner: "ada",
  repo: "docs",
  branch: "main",
  token: "token",
  publishMode: "direct" as const,
  aiTitles: false,
  createdAt: "2026-08-15",
};

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

/** The kind of body MDX exists for: prose wrapped around a real component. */
const MDX_BODY = `import Chart from "../../components/Chart.astro";

Latency fell after the migration.

<Chart data={[1, 2, 3]} caption="p99 latency" />

The rest is ordinary prose.`;

function fakeGitHub() {
  const files = new Map<string, string>([[".cms/schema.yaml", SCHEMA]]);
  const written: Array<{ path: string; content: string }> = [];
  const state = { head: "head-1", blobs: new Map<string, string>() };

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "GET" && pathname.includes("/contents/")) {
      const path = decodeURIComponent(pathname.split("/contents/")[1] ?? "");
      const content = files.get(path);
      if (content === undefined) {
        const children = [...files.keys()].filter((key) => key.startsWith(`${path}/`));
        if (children.length > 0) {
          return json(children.map((key) => ({ path: key, type: "file" })));
        }
        return json({ message: "Not Found" }, 404);
      }
      return json({
        type: "file",
        sha: `sha-${path}`,
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
      });
    }
    if (method === "GET" && pathname.includes("/git/ref/heads/")) {
      return json({ object: { sha: state.head } });
    }
    if (method === "GET" && pathname.includes("/git/commits/")) return json({ tree: { sha: "t" } });
    if (method === "POST" && pathname.endsWith("/git/blobs")) {
      const sha = `blob-${state.blobs.size + 1}`;
      // Text blobs go up as utf-8; only uploads are base64.
      state.blobs.set(
        sha,
        body.encoding === "base64"
          ? Buffer.from(String(body.content), "base64").toString("utf8")
          : String(body.content),
      );
      return json({ sha });
    }
    if (method === "POST" && pathname.endsWith("/git/trees")) {
      for (const entry of body.tree as Array<{ path: string; sha: string }>) {
        const content = state.blobs.get(entry.sha) ?? "";
        written.push({ path: entry.path, content });
        files.set(entry.path, content);
      }
      return json({ sha: "t2" });
    }
    if (method === "POST" && pathname.endsWith("/git/commits")) {
      state.head = "commit-2";
      return json({ sha: state.head, html_url: "https://gh/c2" });
    }
    if (method === "PATCH" && pathname.includes("/git/refs/heads/")) return json({ ok: true });
    return json({ message: `unhandled ${method} ${pathname}` }, 500);
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, written, files };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let github: ReturnType<typeof fakeGitHub>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  clearContextCache();
  github = fakeGitHub();
  const store = new Store(":memory:");
  store.addSite(SITE);
  app = createApp({ store, password: PASSWORD, secret: SECRET, fetch: github.fetchImpl });
});

const signedIn = {
  cookie: createSessionCookie(sessionKey(SECRET, PASSWORD)).split(";")[0] as string,
};

const post = (path: string, fields: Record<string, string>) =>
  app.request(path, {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

describe("the standard", () => {
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
  it("writes an .mdx file with frontmatter above the body", async () => {
    const response = await post("/sites/site-1/collections/guides/new", {
      "f[title]": "Latency",
      "f[content]": MDX_BODY,
    });

    expect(response.status).toBe(200);
    const file = github.written.find((entry) => entry.path.endsWith(".mdx"));
    expect(file?.path).toBe("src/content/guides/latency.mdx");
    expect(file?.content).toMatch(/^---\ntitle: Latency\n---\n/);
  });

  it("leaves the component in the body exactly as it was typed", async () => {
    await post("/sites/site-1/collections/guides/new", {
      "f[title]": "Latency",
      "f[content]": MDX_BODY,
    });

    const file = github.written.find((entry) => entry.path.endsWith(".mdx"));
    expect(file?.content).toContain('<Chart data={[1, 2, 3]} caption="p99 latency" />');
    expect(file?.content).toContain('import Chart from "../../components/Chart.astro";');
  });

  it("reads it back into the form unchanged, so editing twice is safe", async () => {
    await post("/sites/site-1/collections/guides/new", {
      "f[title]": "Latency",
      "f[content]": MDX_BODY,
    });

    const body = await (
      await app.request("/sites/site-1/collections/guides/latency", { headers: signedIn })
    ).text();

    expect(body).toContain("&lt;Chart data={[1, 2, 3]}");
    expect(body).toContain("import Chart from");
  });
});

describe("the editor for an MDX body", () => {
  it("does not mount the visual editor on it", async () => {
    await post("/sites/site-1/collections/guides/new", {
      "f[title]": "Latency",
      "f[content]": MDX_BODY,
    });

    const body = await (
      await app.request("/sites/site-1/collections/guides/latency", { headers: signedIn })
    ).text();

    // data-richtext is what the client script binds to. On MDX it must be absent,
    // or ProseMirror would parse the JSX as HTML and drop it on the next save.
    expect(body).not.toContain("data-richtext");
    expect(body).not.toContain("/assets/editor.js");
    expect(body).toContain("MDX source");
  });

  it("still mounts it for an ordinary Markdown collection", async () => {
    github.files.set(".cms/schema.yaml", SCHEMA.replace("format: mdx", "format: markdown"));

    const body = await (
      await app.request("/sites/site-1/collections/guides/new", { headers: signedIn })
    ).text();

    expect(body).toContain("data-richtext");
    expect(body).toContain("/assets/editor.js");
  });
});

/**
 * Nested blocks — the PayloadCMS-shaped case: a managed section holding
 * composed components rather than a flat list of fields.
 */
describe("a block that contains blocks", () => {
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

  beforeEach(() => {
    github.files.set(".cms/schema.yaml", NESTED_SCHEMA);
  });

  it("renders a type picker for each nested slot, plus a spare one", async () => {
    // A nested picker exists only once its parent does, so add the grid first.
    const response = await post("/sites/site-1/regions/home.body", {
      action: "add",
      addType: "grid",
    });
    const body = await response.text();

    expect(body).toContain("Card grid");
    // The spare slot: choose a type, save, and its fields appear.
    expect(body).toContain('name="f[blocks][0][cards][0][_type]"');
    expect(body).toContain("Save to add another");
  });

  it("publishes the nesting the editor filled in", async () => {
    const response = await post("/sites/site-1/regions/home.body", {
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
    const file = github.written.find((entry) => entry.path.endsWith("home.body.json"));
    const parsed = JSON.parse(file?.content ?? "{}") as {
      blocks: Array<{ _type: string; heading: string; cards: Array<{ title: string }> }>;
    };

    expect(parsed.blocks[0]?._type).toBe("grid");
    expect(parsed.blocks[0]?.cards.map((card) => card.title)).toEqual([
      "Content lives in Git",
      "Nothing at runtime",
    ]);
  });

  it("drops a nested slot set back to none, which is how you remove one", async () => {
    await post("/sites/site-1/regions/home.body", {
      "f[blocks][0][_type]": "grid",
      "f[blocks][0][cards][0][_type]": "card",
      "f[blocks][0][cards][0][title]": "Kept",
      "f[blocks][0][cards][1][_type]": "",
      "f[blocks][0][cards][1][title]": "Discarded",
      action: "publish",
    });

    const file = github.written.find((entry) => entry.path.endsWith("home.body.json"));
    expect(file?.content).toContain("Kept");
    expect(file?.content).not.toContain("Discarded");
  });

  it("refuses to publish a nested block missing a required field", async () => {
    const response = await post("/sites/site-1/regions/home.body", {
      "f[blocks][0][_type]": "grid",
      "f[blocks][0][cards][0][_type]": "card",
      "f[blocks][0][cards][0][body]": "no title",
      action: "publish",
    });

    expect(response.status).toBe(422);
    expect(github.written.filter((entry) => entry.path.endsWith(".json"))).toEqual([]);
    expect(await response.text()).toContain("not valid yet");
  });
});
