/** An error page tells an owner where a folder is, and everyone else only what is inside the site. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, readFlash, sessionKey } from "../src/auth.js";
import { withoutServerPaths } from "../src/redact.js";
import { type Fixture, get, makeSite, PASSWORD, post, SECRET, signedIn, SITE_ID } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text }
collections:
  posts:
    path: content/posts
    format: json
    slug: title
    fields:
      title: { type: text, required: true }
`;
const WORD = "an editor's long password";

let site: Fixture;
let editor: { cookie: string };

beforeEach(async () => {
  site = makeSite({ schema: SCHEMA });
  site.store.addEditor({
    name: "Ed",
    email: "ed@example.com",
    passwordHash: hashPassword(WORD),
    sites: [SITE_ID],
  });
  const response = await site.app.request("/sign-in", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "ed@example.com", password: WORD }),
  });
  editor = {
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] as string)
      .find((value) => value.startsWith("greatcms_session=")) as string,
  };
});

afterEach(() => site.cleanup());

describe("a message without the server's paths", () => {
  const root = "/srv/sites/alpha";

  it("names a file under the site's folder from the folder, and the folder itself as such", () => {
    expect(
      withoutServerPaths(`ENOENT: no such file, open '${root}/content/posts/a.json'`, [root]),
    ).toBe("ENOENT: no such file, open 'content/posts/a.json'");
    expect(withoutServerPaths(`${root} has no .cms/schema.yaml.`, [root])).toBe(
      "The site's folder has no .cms/schema.yaml.",
    );
    expect(withoutServerPaths(`repository at '${root}/' is odd`, [root])).toBe(
      "repository at 'the site's folder' is odd",
    );
  });

  it("takes out every other absolute path, a sibling folder's included", () => {
    const said = withoutServerPaths(
      `fatal: bad config in /home/rca/.gitconfig; see ${root}-beta/x and C:\\Users\\rca\\site (/etc/gitconfig)`,
      [root],
    );
    expect(said).not.toMatch(/home|rca|gitconfig|beta|Users|etc/);
    expect(said).toContain("(a path on this server)");
  });

  it("leaves relative paths, branches and web addresses as they were", () => {
    for (const kept of [
      "origin/main has commits this copy does not.",
      "Unknown collection in .cms/schema.yaml: content/posts",
      "git push failed: https://github.com/acme/site.git/info/refs not found",
      "Use a width / height pair, and/or neither.",
    ]) {
      expect(withoutServerPaths(kept, [root])).toBe(kept);
    }
  });
});

describe("what a broken site tells each person", () => {
  const pages = [
    `/sites/${SITE_ID}`,
    `/sites/${SITE_ID}/regions/home.hero`,
    `/sites/${SITE_ID}/collections/posts`,
    `/sites/${SITE_ID}/collections/posts/new`,
    `/sites/${SITE_ID}/regions/home.hero/history`,
    `/sites/${SITE_ID}/search?q=a`,
  ];

  it("shows a missing schema's folder to the owner alone", async () => {
    rmSync(join(site.root, ".cms/schema.yaml"));
    for (const path of pages) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const answer = await get(site, path, editor);
      expect(answer.status, path).toBe(502);
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const theirs = await answer.text();
      expect(theirs, path).toContain("has no .cms/schema.yaml.");
      expect(theirs, path).not.toContain(site.root);
      expect(theirs, path).not.toContain("/tmp/");
    }
    const theirs = await (await get(site, `/sites/${SITE_ID}`, editor)).text();
    expect(theirs).toContain("The site&#39;s folder has no .cms/schema.yaml.");
    expect(await (await get(site, `/sites/${SITE_ID}`)).text()).toContain(
      `${site.root} has no .cms/schema.yaml.`,
    );
  });

  it("shows a schema that does not parse without the folder it is in", async () => {
    site.write(".cms/schema.yaml", "version: 1\nregions:\n  home.hero: [not, a, region\n");
    for (const path of pages) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const answer = await get(site, path, editor);
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      expect(await answer.text(), path).not.toContain(site.root);
    }
  });

  it("shows what git said without the folder it said it about", async () => {
    const head = site.head();
    writeFileSync(join(site.root, ".git/index.lock"), "");
    const publish = (who: Record<string, string>) =>
      post(
        site,
        `/sites/${SITE_ID}/regions/home.hero`,
        { "f[heading]": "Hello", headSha: head },
        who,
      );
    const owners = await (await publish(signedIn)).text();
    expect(owners).toContain(`${site.root}/.git/index.lock`);

    const answer = await publish(editor);
    expect(answer.status).toBeGreaterThanOrEqual(400);
    const theirs = await answer.text();
    expect(theirs).toContain(".git/index.lock");
    expect(theirs).not.toContain(site.root);
    for (const path of pages) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      expect(await (await get(site, path, editor)).text(), path).not.toContain(site.root);
    }
  });

  it("keeps a path out of the notice a redirect carries", async () => {
    site.store.updateSite(SITE_ID, {
      name: "Example",
      devUrl: "",
      pushAfterPublish: true,
      deployRoot: "",
    });
    // A copy with the branch checked out refuses a push to it, and says where it is.
    const elsewhere = mkdtempSync(join(tmpdir(), "greatcms-elsewhere-"));
    try {
      execFileSync("git", ["clone", "-q", site.root, elsewhere]);
      site.git(["remote", "add", "origin", elsewhere]);
      const create = async (title: string, who: Record<string, string>, actor: string) => {
        const created = await post(
          site,
          `/sites/${SITE_ID}/collections/posts/new`,
          { "f[title]": title },
          who,
        );
        expect(created.status).toBe(303);
        const flash = created.headers
          .getSetCookie()
          .map((value) => value.split(";")[0] as string)
          .find((value) => value.startsWith("greatcms_flash="));
        return readFlash(flash, sessionKey(SECRET, PASSWORD), actor);
      };
      const owners = await create("First post", signedIn, "studio");
      expect(owners?.message).toContain(elsewhere);
      const theirs = await create("Second post", editor, "editor:1");
      expect(theirs?.kind).toBe("error");
      expect(theirs?.message).toContain("not pushed");
      expect(theirs?.message).not.toContain(elsewhere);
      expect(theirs?.message).not.toContain("/tmp/");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("a build that failed", () => {
  it("shows its log to an editor without the builder's folders", async () => {
    const deployRoot = mkdtempSync(join(tmpdir(), "greatcms-builder-"));
    try {
      site.store.updateSite(SITE_ID, {
        name: "Example",
        devUrl: "",
        pushAfterPublish: false,
        deployRoot,
      });
      writeFileSync(
        join(deployRoot, "status.json"),
        JSON.stringify({
          failed: {
            sha: "b".repeat(40),
            message: "Change the hero",
            at: "2026-08-16T10:00:00Z",
            log: [
              "content/posts/hello.json: title is required",
              "  at render (/srv/work/site-1/src/pages/index.astro:12:5)",
              "  at file:///srv/work/site-1/node_modules/astro/dist/core.js:9:1",
              `copying to ${deployRoot}/releases/next failed`,
            ].join("\n"),
          },
        }),
      );
      const owners = await (await get(site, `/sites/${SITE_ID}`)).text();
      expect(owners).toContain("/srv/work/site-1/src/pages/index.astro:12:5");
      expect(owners).toContain(`${deployRoot}/releases/next`);

      const theirs = await (await get(site, `/sites/${SITE_ID}`, editor)).text();
      expect(theirs).toContain("content/posts/hello.json: title is required");
      expect(theirs).toContain("copying to releases/next failed");
      expect(theirs).not.toContain("/srv/work");
      expect(theirs).not.toContain(deployRoot);
    } finally {
      rmSync(deployRoot, { recursive: true, force: true });
    }
  });
});
