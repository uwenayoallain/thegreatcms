/**
 * Defensive hardening tests for:
 * 1. The live preview message channel (studio side)
 * 2. The inspector script (site side)
 * 3. The build-time content reader
 */

/* oxlint-disable no-eval, typescript/no-explicit-any */

/** @vitest-environment jsdom */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CmsReader } from "./index.js";
import { INSPECT_SCRIPT } from "./inspect.js";
import {
  collectionEntryPath,
  DEFAULT_CONFIG,
  isSafeSlug,
  parseFrontmatter,
  parseRegionFile,
  regionFilePath,
} from "@greatcms/spec";

// Polyfill localStorage for Node/JSDOM environment
function ensureLocalStorage() {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: mock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: mock,
    configurable: true,
    writable: true,
  });
}

describe("Property 1: Studio preview message channel", () => {
  let frame: HTMLIFrameElement;
  let postSpy: any;

  beforeAll(async () => {
    ensureLocalStorage();
    document.body.innerHTML = `
      <div class="live-stage is-down">
        <iframe data-live-site="/draft" src="http://preview.example:4321/page"></iframe>
        <form data-editor-form>
          <input name="f[heading]" value="Initial">
          <div id="live-status">Initial status</div>
        </form>
      </div>
    `;
    frame = document.querySelector<HTMLIFrameElement>("iframe")!;
    postSpy = vi.fn();
    frame.contentWindow!.postMessage = postSpy;

    await import("../../../apps/studio/client/live.ts");
  });

  afterAll(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("studio ignores messages from any other window or origin", () => {
    const stage = document.querySelector(".live-stage")!;

    // Case A: message from untrusted origin
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { greatcms: "ready" },
        source: frame.contentWindow,
        origin: "http://attacker.example",
      }),
    );
    expect(stage.classList.contains("is-down")).toBe(true);

    // Case B: message from window itself (not frame)
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { greatcms: "ready" },
        source: window,
        origin: "http://preview.example:4321",
      }),
    );
    expect(stage.classList.contains("is-down")).toBe(true);

    // Case C: matched attempt from untrusted origin
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { greatcms: "matched", fields: 99, of: 99, blocks: 99 },
        source: frame.contentWindow,
        origin: "http://evil.example",
      }),
    );
    expect(document.getElementById("live-status")?.textContent).toBe("Initial status");
  });

  it("studio only acts on messages whose source is its preview frame and origin matches", () => {
    // 1. Message from matching source and origin should be acted upon
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { greatcms: "ready" },
        source: frame.contentWindow,
        origin: "http://preview.example:4321",
      }),
    );

    const stage = document.querySelector(".live-stage")!;
    expect(stage.classList.contains("is-down")).toBe(false);

    // Should update status on matching message
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { greatcms: "matched", fields: 2, of: 2, blocks: 1 },
        source: frame.contentWindow,
        origin: "http://preview.example:4321",
      }),
    );
    expect(document.getElementById("live-status")?.textContent).toContain("1 section and 2 fields");
  });

  it("studio posts to the frame with an explicit target origin, not '*', once the origin is known", () => {
    expect(postSpy).toHaveBeenCalled();
    for (const call of postSpy.mock.calls) {
      const targetOrigin = call[1];
      expect(targetOrigin).toBe("http://preview.example:4321");
      expect(targetOrigin).not.toBe("*");
    }
  });
});

describe("Property 2: Inspector inside the site", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("inspector does nothing at all when the page is not framed", () => {
    Object.defineProperty(window, "top", { value: window, configurable: true });
    Object.defineProperty(window, "self", { value: window, configurable: true });

    const initialNodes = document.body.childNodes.length;
    eval(INSPECT_SCRIPT);

    expect(document.body.childNodes.length).toBe(initialNodes);
    expect(document.querySelector("greatcms-overlay")).toBeNull();
    expect(document.querySelector("style[data-greatcms-preview]")).toBeNull();
  });

  it("inspector only acts on messages from window.parent", () => {
    const fakeParent = { postMessage: vi.fn() };
    Object.defineProperty(window, "top", { value: {}, configurable: true });
    Object.defineProperty(window, "self", { value: window, configurable: true });
    Object.defineProperty(window, "parent", { value: fakeParent, configurable: true });

    eval(INSPECT_SCRIPT);

    // Initial hello is posted to parent
    expect(fakeParent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ greatcms: "ready" }),
      "*",
    );

    // Message from non-parent (e.g. self) should be ignored
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { greatcms: "mode", select: true },
        source: window,
        origin: "http://studio.example",
      }),
    );
    expect(document.documentElement.hasAttribute("data-greatcms-select")).toBe(false);

    // Message from parent is accepted
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { greatcms: "mode", select: true },
        source: fakeParent as any,
        origin: "http://studio.example",
      }),
    );
    expect(document.documentElement.hasAttribute("data-greatcms-select")).toBe(true);
  });

  it("field values it receives are only used as text to compare and never written into the page as HTML", () => {
    const fakeParent = { postMessage: vi.fn() };
    Object.defineProperty(window, "top", { value: {}, configurable: true });
    Object.defineProperty(window, "self", { value: window, configurable: true });
    Object.defineProperty(window, "parent", { value: fakeParent, configurable: true });

    document.body.innerHTML = `<main><h1>Original</h1></main>`;
    eval(INSPECT_SCRIPT);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          greatcms: "fields",
          fields: [
            {
              path: "f[title]",
              dotted: "title",
              label: "Title",
              kind: "text",
              value: '<img id="malicious-field-img" src=x onerror="alert(1)">',
            },
            {
              path: "f[content]",
              dotted: "content",
              label: "Content",
              kind: "richtext",
              value: '<p><script id="malicious-script">alert(1)</script>Injected</p>',
            },
          ],
        },
        source: fakeParent as any,
        origin: "http://studio.example",
      }),
    );

    expect(document.getElementById("malicious-field-img")).toBeNull();
    expect(document.getElementById("malicious-script")).toBeNull();
    expect(document.body.innerHTML).toBe("<main><h1>Original</h1></main>");
  });

  it("inspector overlay cannot be used to inject markup into the page", () => {
    const fakeParent = { postMessage: vi.fn() };
    Object.defineProperty(window, "top", { value: {}, configurable: true });
    Object.defineProperty(window, "self", { value: window, configurable: true });
    Object.defineProperty(window, "parent", { value: fakeParent, configurable: true });

    document.body.innerHTML = `<main><p>About text</p></main>`;
    eval(INSPECT_SCRIPT);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          greatcms: "fields",
          fields: [
            {
              path: "f[about]",
              dotted: "about",
              label: '<span id="xss-label">Hacked Label</span>',
              kind: "text",
              value: "About text",
              block: {
                id: "sec1",
                label: '<div id="xss-block">Hacked Block</div>',
              },
            },
          ],
        },
        source: fakeParent as any,
        origin: "http://studio.example",
      }),
    );

    // Injected markup must not exist in main document
    expect(document.getElementById("xss-label")).toBeNull();
    expect(document.getElementById("xss-block")).toBeNull();

    // Inside shadow root, elements should not be parsed as HTML markup tags
    const overlay = document.querySelector("greatcms-overlay");
    if (overlay?.shadowRoot) {
      expect(overlay.shadowRoot.querySelector("#xss-label")).toBeNull();
      expect(overlay.shadowRoot.querySelector("#xss-block")).toBeNull();
    }
  });
});

describe("Property 3: Reader content reading", () => {
  let tempDirs: string[] = [];

  function makeSite(schemaContent: string, files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "gc-reader-site-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, ".cms"), { recursive: true });
    writeFileSync(join(dir, ".cms/schema.yaml"), schemaContent);
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(dir, relPath);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("content file paths it builds from region ids, collection names and slugs stay inside the site root", () => {
    // Region IDs with path traversal cannot escape site root
    expect(() => regionFilePath(DEFAULT_CONFIG, "../escape")).toThrow(/Invalid region id/);
    expect(() => regionFilePath(DEFAULT_CONFIG, "../../etc/passwd")).toThrow(/Invalid region id/);

    // Slugs with path traversal are marked unsafe and rejected
    expect(isSafeSlug("../escape")).toBe(false);
    expect(isSafeSlug("..")).toBe(false);
    expect(isSafeSlug("/escape")).toBe(false);
    expect(isSafeSlug("folder/sub")).toBe(false);
    expect(isSafeSlug("folder\\sub")).toBe(false);

    expect(() =>
      collectionEntryPath(
        DEFAULT_CONFIG,
        { path: "content/blog", format: "markdown" },
        "../escape",
      ),
    ).toThrow(/Invalid entry slug/);
  });

  it("a symbolic link in content pointing outside the root is not followed", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "gc-outside-"));
    tempDirs.push(outsideDir);
    const outsideSecret = join(outsideDir, "secret.json");
    writeFileSync(outsideSecret, JSON.stringify({ heading: "OUTSIDE_SECRET" }));

    const siteRoot = makeSite(
      `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text, default: DefaultHeading }
`,
    );

    // Create a symlink in content/cms pointing outside the site root
    const contentDir = join(siteRoot, "content/cms");
    mkdirSync(contentDir, { recursive: true });
    symlinkSync(outsideSecret, join(contentDir, "home.hero.json"));

    const reader = new CmsReader({ root: siteRoot, drafts: false });

    // Defensive assertion: an external symlink must NOT be followed to read outside content
    const result = reader.region("home.hero") as { heading: string };
    expect(result.heading).not.toBe("OUTSIDE_SECRET");
  });

  it("malformed JSON in region file gives a clear error naming the file instead of a crash", () => {
    const siteRoot = makeSite(
      `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text }
`,
      {
        "content/cms/home.hero.json": "{ malformed json",
      },
    );

    const reader = new CmsReader({ root: siteRoot, drafts: false });
    expect(() => reader.region("home.hero")).toThrow(/content\/cms\/home\.hero\.json/);
  });

  it("malformed frontmatter in markdown entry gives a clear error naming the file instead of a crash", () => {
    const siteRoot = makeSite(
      `version: 1
collections:
  blog:
    path: content/blog
    format: markdown
    fields:
      title: { type: text }
`,
      {
        "content/blog/bad.md": "---\ntitle: [unclosed list\n---\nBody",
      },
    );

    const reader = new CmsReader({ root: siteRoot, drafts: false });
    expect(() => reader.collection("blog")).toThrow(/content\/blog\/bad\.md/);
  });

  it("malformed JSON in collection entry gives a clear error naming the file instead of a crash", () => {
    const siteRoot = makeSite(
      `version: 1
collections:
  posts:
    path: content/posts
    format: json
    fields:
      title: { type: text }
`,
      {
        "content/posts/broken.json": "{ invalid json content }",
      },
    );

    const reader = new CmsReader({ root: siteRoot, drafts: false });
    // Defensive property: parsing a malformed JSON collection entry must name the file in error
    expect(() => reader.collection("posts")).toThrow(/content\/posts\/broken\.json/);
  });

  it("YAML frontmatter cannot instantiate custom types or execute anything", () => {
    const maliciousFrontmatter = `---
func: !!js/function "function() { return 'executed'; }"
custom: !<tag:custom.org,2002:type> "data"
__proto__:
  polluted: "yes"
---
Markdown body`;

    const result = parseFrontmatter(maliciousFrontmatter, "post.md");
    // Must not execute functions
    expect(typeof result.data.func).not.toBe("function");
    // Must not pollute prototype
    expect(({} as any).polluted).toBeUndefined();
  });

  it("a very large or deeply nested content file is handled without exhausting memory or the stack", () => {
    // 1. YAML alias expansion attack (billion laughs) must be rejected
    const yamlBomb = `---
a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]
f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]
---
Body`;
    expect(() => parseFrontmatter(yamlBomb, "bomb.md")).toThrow(
      /Excessive alias count indicates a resource exhaustion attack/,
    );

    // 2. Deeply nested frontmatter handles recursion limit without unhandled crash
    let deep = "";
    for (let i = 0; i < 2000; i++) deep += `${"  ".repeat(i)}level:\n`;
    deep += `${"  ".repeat(2000)}val\n`;
    expect(() => parseFrontmatter(`---\n${deep}---\nBody`, "deep.md")).toThrow(
      /frontmatter is not valid YAML/,
    );

    // 3. Deeply nested JSON region handles recursion cleanly
    const deepJson = '{"a":'.repeat(2000) + "1" + "}".repeat(2000);
    expect(() => parseRegionFile(deepJson, "deep.json")).not.toThrow();

    // 4. Large content file handled without exhausting memory
    const largeText = "x".repeat(2 * 1024 * 1024); // 2 MB string
    const largeJson = JSON.stringify({ heading: largeText });
    expect(parseRegionFile(largeJson, "large.json").heading).toBe(largeText);
  });
});
