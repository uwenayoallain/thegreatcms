/** Connecting a site from the studio's own pages: the sites folder, copies from Git, starters, previews. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import axe from "axe-core";
import { HtmlValidate } from "html-validate";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  cloneFailure,
  folderFromUrl,
  folderPath,
  isCloneUrl,
  PreviewAddresses,
} from "../src/connect.js";
import { Store } from "../src/db.js";
import { Liveness } from "../src/liveness.js";
import { PASSWORD, SECRET, signedIn } from "./site.js";

const SCHEMA = `version: 1
site:
  name: Ready
regions:
  home.hero:
    label: Hero
    fields:
      heading: { type: text }
`;

let root: string;
let store: Store;
let previewsFile: string;
let gitCalls: string[][];
let cloneResult: () => Promise<void>;

function app() {
  return createApp({
    store,
    password: PASSWORD,
    secret: SECRET,
    sitesRoot: root,
    previewUrl: "https://{site}-preview.example.com",
    previewsFile,
    previewProbe: "http://previews:4321",
    resolveHost: async () => ["93.184.215.14"],
    cloneGit: (args) => {
      gitCalls.push(args);
      return cloneResult().then(() => {
        mkdirSync(args.at(-1) as string, { recursive: true });
        writeFileSync(join(args.at(-1) as string, "README.md"), "copied\n");
      });
    },
  });
}

function folder(name: string, files: Record<string, string> = {}, git = false) {
  const path = join(root, name);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  mkdirSync(path, { recursive: true });
  if (git) {
    const run = (args: string[]) => execFileSync("git", args, { cwd: path, stdio: "ignore" });
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    run(["commit", "-q", "--allow-empty", "-m", "initial"]);
  }
  return path;
}

async function post(target: ReturnType<typeof app>, path: string, fields: Record<string, string>) {
  return target.request(path, {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

async function page(target: ReturnType<typeof app>, path: string) {
  const response = await target.request(path, { headers: signedIn });
  return { response, document: new JSDOM(await response.text()).window.document };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greatcms-sites-"));
  previewsFile = join(mkdtempSync(join(tmpdir(), "greatcms-previews-")), "sites.json");
  store = new Store(":memory:");
  gitCalls = [];
  cloneResult = () => Promise.resolve();
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the sites list's address", () => {
  it("sends /sites to the list instead of a 404", async () => {
    const response = await app().request("/sites", { headers: signedIn });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/");
  });
});

describe("typing a folder path", () => {
  it("reads ~ as the home folder and asks for a full path otherwise", () => {
    expect(folderPath("~/sites/one")).toEqual({ path: join(homedir(), "sites/one") });
    expect(folderPath("~")).toEqual({ path: homedir() });
    expect(folderPath("sites/one")).toHaveProperty("error");
  });

  it("says a relative path needs to be a full one, on the field", async () => {
    const response = await post(app(), "/sites", { path: "projects/site" });
    const { document } = new JSDOM(await response.text()).window;
    expect(response.status).toBe(422);
    expect(document.querySelector("#path-hint-error")?.textContent).toContain("full path");
  });
});

describe("the sites folder", () => {
  it("lists its folders: ready first, then ones to set up, then connected", async () => {
    folder("zeta", { ".cms/schema.yaml": SCHEMA });
    folder("alpha");
    folder(".hidden", { ".cms/schema.yaml": SCHEMA });
    folder("node_modules");
    const target = app();
    await post(target, "/sites", { path: join(root, "zeta") });
    folder("beta", { ".cms/schema.yaml": SCHEMA });

    const { document } = await page(target, "/sites/new");
    const rows = [...document.querySelectorAll("#found ~ .folders li, .folders li")].map((row) =>
      row.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows).toEqual([
      expect.stringContaining("beta Ready to connect"),
      expect.stringContaining("alpha No .cms/schema.yaml yet"),
      expect.stringContaining("zeta Connected"),
    ]);
  });

  it("connects a folder with one click, named after it, with a preview address", async () => {
    folder("nesa-petroleum", { ".cms/schema.yaml": SCHEMA });
    const response = await post(app(), "/sites", { path: join(root, "nesa-petroleum") });

    expect(response.status).toBe(303);
    const [site] = store.listSites();
    expect(site?.name).toBe("Nesa petroleum");
    expect(site?.devUrl).toBe("https://nesa-petroleum-preview.example.com");
    expect(JSON.parse(readFileSync(previewsFile, "utf8"))).toEqual({
      version: 1,
      sites: [
        {
          id: site?.id,
          name: "Nesa petroleum",
          host: "nesa-petroleum-preview.example.com",
          path: join(root, "nesa-petroleum"),
        },
      ],
    });
  });

  it("keeps the preview list in step when a site changes or goes", async () => {
    folder("one", { ".cms/schema.yaml": SCHEMA });
    const target = app();
    await post(target, "/sites", { path: join(root, "one") });
    const [site] = store.listSites();
    const listed = () => JSON.parse(readFileSync(previewsFile, "utf8")).sites;

    await post(target, `/sites/${site?.id}/settings`, {
      name: "One",
      devUrl: "http://localhost:4321",
    });
    expect(listed()).toEqual([]);
    await post(target, `/sites/${site?.id}/settings`, {
      name: "One",
      devUrl: "https://one-preview.example.com",
    });
    expect(listed()).toHaveLength(1);
    await post(target, `/sites/${site?.id}/delete`, {});
    expect(listed()).toEqual([]);
  });

  it("gives a second site with the same folder name its own preview address", () => {
    const addresses = new PreviewAddresses("https://{site}-preview.example.com");
    const taken = [{ devUrl: "https://shop-preview.example.com" }] as never;
    expect(addresses.suggest("Shop", taken)).toBe("https://shop-2-preview.example.com");
    expect(addresses.nameOf("https://shop-preview.example.com/")).toBe("shop");
    expect(addresses.nameOf("https://evil.com/?https://shop-preview.example.com")).toBeNull();
  });

  it("refuses a preview template without a place for the site's name", () => {
    expect(() => new PreviewAddresses("https://preview.example.com")).toThrow("{site}");
    expect(() => new PreviewAddresses("https://example.com/{site}")).toThrow("host name");
  });

  it("keeps a dev URL someone typed", async () => {
    folder("typed", { ".cms/schema.yaml": SCHEMA });
    await post(app(), "/sites", { path: join(root, "typed"), devUrl: "http://localhost:4400" });
    expect(store.listSites()[0]?.devUrl).toBe("http://localhost:4400");
  });

  it("asks the preview service whether a preview it runs is up", async () => {
    const probed: string[] = [];
    const liveness = new Liveness(new Map(), (site) => {
      probed.push(site.devUrl);
      return "http://127.0.0.1:9";
    });
    await liveness.running({ id: "a", devUrl: "https://a-preview.example.com" } as never);
    expect(probed).toEqual(["https://a-preview.example.com"]);
  });

  it.each(["/sites/new", `/sites/setup?path=`])("%s has no axe violations", async (path) => {
    folder("ready", { ".cms/schema.yaml": SCHEMA });
    const bare = folder("bare");
    const target = app();
    const response = await target.request(
      path.endsWith("=") ? path + encodeURIComponent(bare) : path,
      {
        headers: signedIn,
      },
    );
    const { window } = new JSDOM(await response.text(), { url: "https://studio.test/" });
    Object.assign(globalThis, { window, document: window.document, Node: window.Node });
    const results = await axe.run(window.document.documentElement, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("is valid HTML with folders, copies and failures on it", async () => {
    folder("ready", { ".cms/schema.yaml": SCHEMA });
    folder("bare");
    cloneResult = () => Promise.reject(Object.assign(new Error("x"), { stderr: "fatal: oops" }));
    const target = app();
    await post(target, "/sites", { path: join(root, "ready") });
    await post(target, "/sites/clone", { url: "https://example.com/broken.git" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    cloneResult = () => new Promise(() => {});
    await post(target, "/sites/clone", { url: "https://example.com/slow.git" });

    const response = await target.request("/sites/new", { headers: signedIn });
    const report = await new HtmlValidate({
      extends: ["html-validate:standard"],
      rules: {
        "void-style": "off",
        "doctype-style": "off",
        "attribute-boolean-style": "off",
        "attribute-empty-style": "off",
        "no-trailing-whitespace": "off",
        "no-inline-style": "off",
        "no-redundant-role": "off",
      },
    }).validateString(await response.text());
    expect(
      report.results.flatMap((result) => result.messages.map((m) => `${m.ruleId}: ${m.message}`)),
    ).toEqual([]);
  });
});

describe("warming a preview", () => {
  it("starts a site's dev server when its page opens, and none from the sites list", async () => {
    const asked: string[] = [];
    const service = createServer((req, res) => {
      if (req.url === "/__greatcms/warm") asked.push(req.headers.host ?? "");
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const probe = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    folder("shop", { ".cms/schema.yaml": SCHEMA });
    const target = createApp({
      store,
      password: PASSWORD,
      secret: SECRET,
      sitesRoot: root,
      previewUrl: "https://{site}-preview.example.com",
      previewProbe: probe,
    });
    await post(target, "/sites", { path: join(root, "shop") });
    const [site] = store.listSites();

    await target.request("/", { headers: signedIn });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked).toEqual([]);

    await target.request(`/sites/${site?.id}`, { headers: signedIn });
    await expect.poll(() => asked).toEqual(["shop-preview.example.com"]);
    service.close();
  });
});

describe("a folder without a schema", () => {
  it("offers a starter instead of a dead end", async () => {
    const path = folder("plain");
    const response = await post(app(), "/sites", { path });
    const { document } = new JSDOM(await response.text()).window;

    expect(response.status).toBe(422);
    expect(document.querySelector("form[action='/sites/setup']")).toBeTruthy();
    expect(
      [...document.querySelectorAll("input[name=template]")].map((input) =>
        input.getAttribute("value"),
      ),
    ).toEqual(["hero", "landing", "business", "blog", "blank"]);
    expect(store.listSites()).toEqual([]);
  });

  it("writes the starter as one commit and connects the site", async () => {
    const path = folder(
      "shop",
      { "package.json": JSON.stringify({ dependencies: { astro: "5" } }), "src/index.astro": "" },
      true,
    );
    const response = await post(app(), "/sites/setup", { path, name: "Shop", template: "landing" });

    expect(response.status).toBe(303);
    expect(readFileSync(join(path, ".cms/schema.yaml"), "utf8")).toContain("name: Shop");
    expect(readFileSync(join(path, ".cms/config.yaml"), "utf8")).toContain("src/content/cms");
    const log = execFileSync("git", ["log", "--format=%s", "--name-only", "-1"], {
      cwd: path,
      encoding: "utf8",
    });
    expect(log.split("\n").filter(Boolean)).toEqual([
      "Set up GreatCMS",
      ".cms/config.yaml",
      ".cms/schema.yaml",
    ]);
    expect(store.listSites().map((site) => site.name)).toEqual(["Shop"]);
  });

  it("never overwrites a schema that is already there", async () => {
    const path = folder("done", { ".cms/schema.yaml": SCHEMA });
    const response = await post(app(), "/sites/setup", { path, name: "Done", template: "blank" });

    expect(response.status).toBe(422);
    expect(readFileSync(join(path, ".cms/schema.yaml"), "utf8")).toBe(SCHEMA);
  });

  it("asks for a template it knows", async () => {
    const path = folder("odd");
    const response = await post(app(), "/sites/setup", { path, name: "Odd", template: "../x" });
    expect(response.status).toBe(422);
    expect(existsSync(join(path, ".cms"))).toBe(false);
  });
});

describe("copying from Git", () => {
  it("clones into the sites folder with nothing from the repository allowed to run", async () => {
    const target = app();
    const response = await post(target, "/sites/clone", {
      url: "https://github.com/someone/my-site.git",
      branch: "main",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(response.status).toBe(303);
    const args = gitCalls[0] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "core.hooksPath=/dev/null",
        "protocol.ext.allow=never",
        "protocol.file.allow=never",
        "--no-recurse-submodules",
      ]),
    );
    expect(args.slice(-3)).toEqual([
      "--",
      "https://github.com/someone/my-site.git",
      expect.any(String),
    ]);
    expect(existsSync(join(root, "my-site", "README.md"))).toBe(true);

    const { document } = await page(target, "/sites/new");
    expect(document.querySelector(".folders")?.textContent).toContain("my-site");
  });

  it("shows the clone while it runs, and why it failed when it does", async () => {
    const settle: { fail?: (error: Error) => void } = {};
    cloneResult = () => new Promise((_, reject) => (settle.fail = reject));
    const target = app();
    await post(target, "/sites/clone", { url: "https://example.com/private.git" });

    let { document } = await page(target, "/sites/new");
    expect(document.querySelector("meta[http-equiv=refresh]")).toBeTruthy();
    expect(document.body.textContent).toContain("Copying from");

    settle.fail?.(
      Object.assign(new Error("failed"), {
        stderr:
          "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    ({ document } = await page(target, "/sites/new"));
    expect(document.querySelector("meta[http-equiv=refresh]")).toBeNull();
    expect(document.body.textContent).toContain("asked for a sign-in");
    expect(existsSync(join(root, "private"))).toBe(false);
    expect(existsSync(join(root, ".private.cloning"))).toBe(false);

    await post(target, "/sites/clone/dismiss", { folder: "private" });
    ({ document } = await page(target, "/sites/new"));
    expect(document.body.textContent).not.toContain("asked for a sign-in");
  });

  it.each([
    ["a local path", "/home/someone/repo"],
    ["file://", "file:///etc"],
    ["a command transport", "ext::sh -c touch% /tmp/pwned"],
    ["an option", "--upload-pack=touch /tmp/pwned"],
  ])("refuses %s", async (_name, url) => {
    const response = await post(app(), "/sites/clone", { url });
    expect(response.status).toBe(422);
    expect(gitCalls).toEqual([]);
  });

  it("refuses a folder that exists or would land outside the sites folder", async () => {
    folder("taken");
    const target = app();
    const answers = await Promise.all(
      [
        { url: "https://example.com/taken.git" },
        { url: "https://example.com/x.git", folder: "../escape" },
        { url: "https://example.com/x.git", folder: ".git" },
        { url: "https://example.com/x.git", branch: "--upload-pack=x" },
      ].map((fields) => post(target, "/sites/clone", fields)),
    );
    expect(answers.map((answer) => answer.status)).toEqual([422, 422, 422, 422]);
    expect(gitCalls).toEqual([]);
  });

  it("reads clone addresses the way git does", () => {
    expect(isCloneUrl("git@github.com:me/site.git")).toBe(true);
    expect(isCloneUrl("ssh://git@example.com/me/site.git")).toBe(true);
    expect(folderFromUrl("git@github.com:me/site.git")).toBe("site");
    expect(folderFromUrl("https://example.com/me/site/")).toBe("site");
    expect(
      cloneFailure(Object.assign(new Error(""), { stderr: "fatal: https://u:p@h/x: boom" })),
    ).not.toContain("u:p");
  });

  it("is not offered without a sites folder", async () => {
    const plain = createApp({ store, password: PASSWORD, secret: SECRET });
    const { document } = await page(plain, "/sites/new");
    expect(document.querySelector("form[action='/sites/clone']")).toBeNull();
    expect((await post(plain, "/sites/clone", { url: "https://example.com/a.git" })).status).toBe(
      404,
    );
  });
});
