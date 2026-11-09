/** Publishing reaches the remote when the site asks for it, so an edit goes live like any other push. */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRemoteAuth } from "../src/repo.js";
import { get, makeSite, post, SITE_ID, type Fixture } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text, required: true }
`;

let site: Fixture;
let remote: string;
let elsewhere: string;

const remoteHead = () =>
  execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }).trim();

const publish = (heading: string) =>
  post(site, `/sites/${SITE_ID}/regions/home.hero`, {
    headSha: site.head(),
    action: "publish",
    "f[heading]": heading,
  });

beforeEach(() => {
  site = makeSite({ schema: SCHEMA });
  remote = mkdtempSync(join(tmpdir(), "greatcms-remote-"));
  elsewhere = mkdtempSync(join(tmpdir(), "greatcms-elsewhere-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  site.git(["remote", "add", "origin", remote]);
  site.git(["push", "-q", "-u", "origin", "main"]);
});

afterEach(() => {
  site.cleanup();
  rmSync(remote, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

const enablePush = () =>
  post(site, `/sites/${SITE_ID}/settings`, { name: "Example", devUrl: "", pushAfterPublish: "on" });

describe("push after publish", () => {
  it("is off until the site turns it on", async () => {
    const response = await publish("Stays here");

    expect(response.status).toBe(200);
    expect(remoteHead()).not.toBe(site.head());
    const page = (await (await get(site, `/sites/${SITE_ID}`)).text()).replace(/\s+/g, " ");
    expect(page).toContain("1 publish not pushed yet");
  });

  it("sends each publish to the remote, and says so", async () => {
    await enablePush();
    const response = await publish("Live now");
    const body = await response.text();

    expect(remoteHead()).toBe(site.head());
    expect(body).toContain("pushed to origin/main");
    expect(site.store.getSite(SITE_ID)?.pushAfterPublish).toBe(true);
  });

  it("hands git the sign-in for the remote it pushes to, for that one push", async () => {
    await enablePush();
    const asked: string[] = [];
    // Config that sends the push somewhere else proves git received it.
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", elsewhere]);
    useRemoteAuth(async (url) => {
      asked.push(url);
      return [[`url.${elsewhere}.insteadOf`, remote]];
    });
    try {
      await publish("Signed in");
    } finally {
      useRemoteAuth(undefined);
    }

    expect(asked).toEqual([remote]);
    expect(
      execFileSync("git", ["rev-parse", "main"], { cwd: elsewhere, encoding: "utf8" }).trim(),
    ).toBe(site.head());
    expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("keeps the commit and says what went wrong when the remote refuses it", async () => {
    await enablePush();
    // Someone else pushed first, so this copy is behind.
    execFileSync("git", ["clone", "-q", remote, elsewhere]);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "theirs",
      ],
      { cwd: elsewhere },
    );
    execFileSync("git", ["push", "-q"], { cwd: elsewhere });
    const theirs = remoteHead();

    const response = await publish("Mine");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Published as");
    expect(body).toContain("not pushed");
    expect(body).toMatch(/pull/i);
    expect(remoteHead()).toBe(theirs);
    expect(site.read("content/cms/home.hero.json")).toContain("Mine");
  });

  it("pushes whatever is waiting from the site page", async () => {
    await publish("Waiting");
    const response = await post(site, `/sites/${SITE_ID}/push`, {});

    expect(response.status).toBe(303);
    expect(remoteHead()).toBe(site.head());
    const page = await (await get(site, `/sites/${SITE_ID}`)).text();
    expect(page).not.toContain("not pushed yet");
  });

  it("never runs the repository's own hooks", async () => {
    await enablePush();
    const marker = join(site.root, "hook-ran");
    const hook = join(site.root, ".git/hooks/pre-push");
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hook, 0o755);

    await publish("No hooks");

    expect(remoteHead()).toBe(site.head());
    expect(existsSync(marker)).toBe(false);
  });

  it("pushes a branch new to the remote to the same name there, and tracks it", async () => {
    site.git(["switch", "-q", "-c", "greatcms-content"]);
    site.commit("notes.txt", "on the branch\n");
    const response = await post(site, `/sites/${SITE_ID}/push`, {});

    expect(response.status).toBe(303);
    const pushed = execFileSync("git", ["rev-parse", "greatcms-content"], {
      cwd: remote,
      encoding: "utf8",
    }).trim();
    expect(pushed).toBe(site.head());
    expect(remoteHead()).not.toBe(site.head());
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "@{u}"], {
        cwd: site.root,
        encoding: "utf8",
      }).trim(),
    ).toBe("origin/greatcms-content");
  });

  it("explains a repository with nowhere to push", async () => {
    site.git(["remote", "remove", "origin"]);
    const response = await post(site, `/sites/${SITE_ID}/push`, {});

    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/no remote to push to/i);
  });
});
