/** Publishing onto a branch of its own, so the branch the live site deploys from is left alone. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewUrl } from "../src/app.js";
import { get, makeSite, post, SITE_ID, type Fixture } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text, required: true }
`;

let site: Fixture;
let remote: string;

const onRemote = (ref: string) =>
  execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
    cwd: remote,
    encoding: "utf8",
  }).trim();

const settings = (fields: Record<string, string>) =>
  post(site, `/sites/${SITE_ID}/settings`, { name: "Example", devUrl: "", ...fields });

const publish = (heading: string) =>
  post(site, `/sites/${SITE_ID}/regions/home.hero`, {
    headSha: site.head(),
    action: "publish",
    "f[heading]": heading,
  });

beforeEach(() => {
  site = makeSite({ schema: SCHEMA });
  remote = mkdtempSync(join(tmpdir(), "greatcms-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  site.git(["remote", "add", "origin", remote]);
  site.git(["push", "-q", "-u", "origin", "main"]);
  // What a clone records: which branch the remote treats as main.
  site.git(["remote", "set-head", "origin", "main"]);
});

afterEach(() => {
  site.cleanup();
  rmSync(remote, { recursive: true, force: true });
});

describe("a branch of its own", () => {
  it("warns in settings that the main branch is where publishes would go live", async () => {
    const { document } = new JSDOM(await (await get(site, `/sites/${SITE_ID}/settings`)).text())
      .window;
    expect(document.querySelector<HTMLInputElement>("#branch")?.value).toBe("main");
    expect(document.querySelector(".notice.warn")?.textContent).toContain("main branch");
  });

  it("starts a new branch, publishes on it and pushes only there, leaving main as it was", async () => {
    const live = onRemote("main");
    const saved = await settings({ branch: "greatcms-content", pushAfterPublish: "on" });
    expect(saved.status).toBe(303);

    const response = await publish("Ready for review");
    expect(response.status).toBe(200);
    expect(onRemote("greatcms-content")).toBe(site.head());
    expect(onRemote("main")).toBe(live);

    const { document } = new JSDOM(await (await get(site, `/sites/${SITE_ID}`)).text()).window;
    expect(document.body.textContent?.replace(/\s+/g, " ")).toContain(
      "pushed to origin/greatcms-content",
    );
    const again = new JSDOM(await (await get(site, `/sites/${SITE_ID}/settings`)).text()).window
      .document;
    expect(again.querySelector(".notice.warn")).toBeNull();
  });

  it("picks up a branch that already exists on the remote, someone else's included", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "greatcms-elsewhere-"));
    execFileSync("git", ["clone", "-q", remote, elsewhere]);
    const git = (args: string[]) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
        cwd: elsewhere,
      });
    git(["switch", "-q", "-c", "review"]);
    git(["commit", "-q", "--allow-empty", "-m", "started elsewhere"]);
    git(["push", "-q", "origin", "review"]);

    expect((await settings({ branch: "review" })).status).toBe(303);
    expect(site.head()).toBe(onRemote("review"));
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "@{u}"], {
        cwd: site.root,
        encoding: "utf8",
      }).trim(),
    ).toBe("origin/review");
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("will not move a folder with work nobody committed, and saves nothing", async () => {
    site.write("notes.txt", "a developer's work in progress\n");
    const response = await settings({ branch: "greatcms-content", name: "Renamed" });
    const { document } = new JSDOM(await response.text()).window;

    expect(response.status).toBe(422);
    expect(document.querySelector("#branch-hint-error")?.textContent).toContain("not committed");
    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: site.root,
        encoding: "utf8",
      }).trim(),
    ).toBe("main");
    expect(site.store.getSite(SITE_ID)?.name).not.toBe("Renamed");
  });

  it("refuses a name Git would not take, or one read as an option", async () => {
    for (const branch of ["two words", "--force", "a..b"]) {
      // oxlint-disable-next-line no-await-in-loop -- each must leave the folder where it was
      expect((await settings({ branch })).status).toBe(422);
    }
  });
});

function state(branch: string, remoteUrl: string) {
  return { branch, remote: "origin", remoteUrl, defaultBranch: "main" };
}

describe("reviewing on GitHub", () => {
  it("links a branch's comparison with main, for https and SSH remotes", () => {
    expect(reviewUrl(state("greatcms-content", "https://github.com/acme/site.git"))).toBe(
      "https://github.com/acme/site/compare/main...greatcms-content?expand=1",
    );
    expect(reviewUrl(state("content/june", "git@github.com:acme/site.git"))).toBe(
      "https://github.com/acme/site/compare/main...content%2Fjune?expand=1",
    );
  });

  it("offers nothing on the main branch itself or on another host", () => {
    expect(reviewUrl(state("main", "https://github.com/acme/site.git"))).toBeUndefined();
    expect(reviewUrl(state("x", "https://gitlab.com/acme/site.git"))).toBeUndefined();
  });
});
