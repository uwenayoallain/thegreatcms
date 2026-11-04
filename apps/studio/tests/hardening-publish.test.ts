/** Hardening regression tests for the studio publish, deploy status, scheduling, and rollback paths. */

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
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLive, requestRollback } from "../src/deploys.js";
import { ConflictError, LocalRepository } from "../src/repo.js";
import { SiteClient } from "../src/sites.js";
import { get, makeSite, post, SITE_ID, type Fixture } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    label: Home hero
    fields:
      heading: { type: text, required: true }
      subtitle: { type: text }
  home.footer:
    label: Footer
    fields:
      copyright: { type: text, required: true }
collections:
  posts:
    label: Posts
    path: content/posts
    format: json
    slug: title
    fields:
      title: { type: text, required: true }
`;

let site: Fixture;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  site = makeSite({ schema: SCHEMA });
});

afterEach(() => {
  site.cleanup();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const pad = (n: number) => String(n).padStart(2, "0");
const futureLocal = () => {
  const at = new Date(Date.now() + 24 * 60 * 60_000);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
};
const afterDue = () => Date.now() + 48 * 60 * 60_000;

describe("property 2: builder status files in deploys.ts are treated as untrusted text", () => {
  const VALID_SHA = "a".repeat(40);
  let deployRoot: string;

  beforeEach(() => {
    deployRoot = makeTempDir("greatcms-deploy-root-");
    mkdirSync(join(deployRoot, "releases", VALID_SHA), { recursive: true });
    site.store.updateSite(SITE_ID, {
      name: "Example",
      devUrl: "",
      pushAfterPublish: false,
      deployRoot,
    });
  });

  it("returns null on malformed status.json and renders the site page cleanly", async () => {
    writeFileSync(join(deployRoot, "status.json"), "{not-valid-json");
    expect(await readLive(deployRoot)).toBeNull();

    const response = await get(site, `/sites/${SITE_ID}`);
    expect(response.status).toBe(200);
  });

  it("escapes HTML payloads in status.json and rollback when rendering the site page", async () => {
    const xss = '<script data-attack="1">alert(1)</script><img src=x onerror=alert(1)>';
    writeFileSync(
      join(deployRoot, "status.json"),
      JSON.stringify({
        live: { sha: VALID_SHA, message: xss, at: xss },
        failed: { sha: "b".repeat(40), message: xss, at: xss, log: xss },
        checkedAt: xss,
      }),
    );
    writeFileSync(join(deployRoot, "rollback"), xss);

    const response = await get(site, `/sites/${SITE_ID}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("<script data-attack=");
    expect(html).not.toContain("<img src=x onerror=");
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector("[data-attack]")).toBeNull();
    expect(doc.querySelector("img[onerror]")).toBeNull();
  });

  it("tolerates unexpected fields, wrong field types, and oversized status.json without crashing", async () => {
    writeFileSync(
      join(deployRoot, "status.json"),
      JSON.stringify({
        live: { message: "missing sha and at" },
        failed: { message: "missing sha" },
        checkedAt: 12345,
        unexpectedField: "should-not-leak",
      }),
    );

    const live = await readLive(deployRoot);
    expect(live).not.toHaveProperty("unexpectedField");

    const response = await get(site, `/sites/${SITE_ID}`);
    expect(response.status).toBe(200);

    // Oversized status.json (e.g. > 1 MB) should be rejected rather than read unbounded.
    writeFileSync(
      join(deployRoot, "status.json"),
      JSON.stringify({
        live: { sha: VALID_SHA, message: "x".repeat(2 * 1024 * 1024), at: "2026-10-13T08:00:00Z" },
        checkedAt: "2026-10-13T08:00:00Z",
      }),
    );
    expect(await readLive(deployRoot)).toBeNull();
  });

  it("never reads files outside the builder folder via symlinks or paths in status files", async () => {
    const outside = makeTempDir("greatcms-outside-deploy-");
    writeFileSync(join(outside, "secret.txt"), "SECRET_TOKEN_VALUE");
    writeFileSync(
      join(outside, "external-status.json"),
      JSON.stringify({
        live: { sha: VALID_SHA, message: "EXTERNAL_STATUS_LEAK", at: "2026-10-13T08:00:00Z" },
        checkedAt: "2026-10-13T08:00:00Z",
      }),
    );

    symlinkSync(join(outside, "external-status.json"), join(deployRoot, "status.json"));
    symlinkSync(join(outside, "secret.txt"), join(deployRoot, "rollback"));

    const live = await readLive(deployRoot);
    expect(live).toBeNull();

    const response = await get(site, `/sites/${SITE_ID}`);
    const html = await response.text();
    expect(html).not.toContain("EXTERNAL_STATUS_LEAK");
    expect(html).not.toContain("SECRET_");
  });
});

describe("property 3: publish concurrency, conflicts, atomicity, and draft isolation", () => {
  it("serializes two racing publishes to different regions into two separate commits", async () => {
    const startHead = site.head();
    const beforeCount = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: site.root,
        encoding: "utf8",
      }),
    );

    const [resHero, resFooter] = await Promise.all([
      post(site, `/sites/${SITE_ID}/regions/home.hero`, {
        headSha: startHead,
        action: "publish",
        "f[heading]": "Concurrent Hero",
      }),
      post(site, `/sites/${SITE_ID}/regions/home.footer`, {
        headSha: startHead,
        action: "publish",
        "f[copyright]": "Concurrent Footer",
      }),
    ]);

    expect(resHero.status).toBe(200);
    expect(resFooter.status).toBe(200);

    const afterCount = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: site.root,
        encoding: "utf8",
      }),
    );
    expect(afterCount - beforeCount).toBe(2);

    expect(JSON.parse(site.read("content/cms/home.hero.json")).heading).toBe("Concurrent Hero");
    expect(JSON.parse(site.read("content/cms/home.footer.json")).copyright).toBe(
      "Concurrent Footer",
    );

    // Neither commit is a mixed commit touching both files.
    const latestFiles = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: site.root,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    const previousFiles = execFileSync("git", ["show", "--name-only", "--format=", "HEAD~1"], {
      cwd: site.root,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(latestFiles).toHaveLength(1);
    expect(previousFiles).toHaveLength(1);
  });

  it("produces one commit and one 409 conflict when two publishes race on the same region", async () => {
    site.commit("content/cms/home.hero.json", JSON.stringify({ heading: "Original" }));
    const startHead = site.head();

    const [first, second] = await Promise.all([
      post(site, `/sites/${SITE_ID}/regions/home.hero`, {
        headSha: startHead,
        action: "publish",
        "f[heading]": "Editor One",
      }),
      post(site, `/sites/${SITE_ID}/regions/home.hero`, {
        headSha: startHead,
        action: "publish",
        "f[heading]": "Editor Two",
      }),
    ]);

    const statuses = [first.status, second.status].toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    expect(JSON.parse(site.read("content/cms/home.hero.json")).heading).toBe("Editor One");
  });

  it("refuses a publish whose expected head no longer matches with 409", async () => {
    const oldHead = site.head();
    site.commit("content/cms/home.hero.json", JSON.stringify({ heading: "Newer" }));

    const staleResponse = await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: oldHead,
      action: "publish",
      "f[heading]": "Stale overwrite",
    });
    expect(staleResponse.status).toBe(409);
    expect(JSON.parse(site.read("content/cms/home.hero.json")).heading).toBe("Newer");

    const bogusResponse = await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: "0".repeat(40),
      action: "publish",
      "f[heading]": "Bogus head",
    });
    expect(bogusResponse.status).toBe(409);

    const repo = new LocalRepository(site.root);
    await expect(
      repo.commitFiles({
        message: "stale",
        files: [{ path: "content/cms/home.hero.json", content: '{"heading":"Nope"}\n' }],
        expectedHeadSha: oldHead,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("leaves no half-written or uncommitted files behind when a git commit fails", async () => {
    site.commit("content/cms/home.hero.json", '{"heading":"Committed"}\n');
    writeFileSync(join(site.root, ".git/index.lock"), "");

    const response = await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: "",
      action: "publish",
      "f[heading]": "Should Not Stick On Disk",
    });
    expect(response.status).toBe(502);

    const newRegion = await post(site, `/sites/${SITE_ID}/regions/home.footer`, {
      headSha: "",
      action: "publish",
      "f[copyright]": "Should Not Exist On Disk",
    });
    expect(newRegion.status).toBe(502);

    rmSync(join(site.root, ".git/index.lock"), { force: true });

    expect(site.exists("content/cms/home.footer.json")).toBe(false);
    expect(JSON.parse(site.read("content/cms/home.hero.json")).heading).toBe("Committed");
  });

  it("never publishes a draft for one region as part of another", async () => {
    await post(site, `/sites/${SITE_ID}/regions/home.footer/draft`, {
      "f[copyright]": "Draft footer only",
    });
    expect(site.exists(".cms/draft/content/cms/home.footer.json")).toBe(true);

    const publishHero = await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: site.head(),
      action: "publish",
      "f[heading]": "Published hero",
    });
    expect(publishHero.status).toBe(200);

    expect(site.exists("content/cms/home.footer.json")).toBe(false);
    expect(site.exists(".cms/draft/content/cms/home.footer.json")).toBe(true);
    const committedFiles = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: site.root,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(committedFiles).toEqual(["content/cms/home.hero.json"]);
  });
});

describe("property 4: git author and commit message safety", () => {
  it("strips newlines and angle brackets from author name and email and prevents git option injection", async () => {
    const repo = new LocalRepository(site.root);
    await repo.commitFiles({
      message: "author test",
      author: {
        name: "--author=Spoof <spoof@evil.com>\r\nCo-authored-by: Mallorie <m@evil.com>",
        email: "alice@example.com>\nCommitter: Spoof <spoof@evil.com",
      },
      files: [{ path: "content/cms/home.hero.json", content: '{"heading":"Safe author"}\n' }],
    });

    const rawCommit = execFileSync("git", ["cat-file", "-p", "HEAD"], {
      cwd: site.root,
      encoding: "utf8",
    });
    const headerLines = rawCommit.split("\n\n")[0]!.split("\n");
    const authorLines = headerLines.filter((line) => line.startsWith("author "));
    expect(authorLines).toHaveLength(1);
    expect(headerLines.some((line) => line.startsWith("Co-authored-by:"))).toBe(false);
    expect(headerLines.some((line) => line.startsWith("Committer:"))).toBe(false);

    const formatted = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: site.root,
      encoding: "utf8",
    }).trim();
    expect(formatted).not.toContain("\n");
    expect(formatted).not.toContain("\r");
    expect(formatted).toBe(
      "--author=Spoof spoof@evil.comCo-authored-by: Mallorie m@evil.com <alice@example.comCommitter: Spoof spoof@evil.com>",
    );
  });

  it("passes commit messages built from templates and region ids safely without flag or shell execution", async () => {
    const marker = join(site.root, "cmd-ran");
    site.write(
      ".cms/config.yaml",
      `version: 1\npublish:\n  commitMessage: "--amend -q $(touch ${marker}) \`touch ${marker}\` {summary}"\n`,
    );
    const beforeHead = site.head();
    const client = new SiteClient(site.store.getSite(SITE_ID)!);
    const context = await client.context();

    await client.publishRegion({
      context,
      regionId: "home.hero",
      document: { heading: "Template safety" },
    });

    expect(existsSync(marker)).toBe(false);
    // A new commit was created rather than amending the initial commit.
    const parent = execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd: site.root,
      encoding: "utf8",
    }).trim();
    expect(parent).toBe(beforeHead);

    const subject = execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd: site.root,
      encoding: "utf8",
    }).trim();
    expect(subject).toContain("home.hero");
    expect(subject.startsWith("--amend -q")).toBe(true);
  });
});

describe("property 5: scheduled publishes", () => {
  it("runs a scheduled job only once even when runDueSchedules is called concurrently", async () => {
    const beforeCount = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: site.root,
        encoding: "utf8",
      }),
    );

    const res = await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: site.head(),
      action: "schedule",
      publishAt: futureLocal(),
      "f[heading]": "Once only",
    });
    expect(res.status).toBe(303);

    const future = afterDue();
    await Promise.all([
      site.app.runDueSchedules(future),
      site.app.runDueSchedules(future),
      site.app.runDueSchedules(future),
    ]);

    const afterCount = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: site.root,
        encoding: "utf8",
      }),
    );
    expect(afterCount - beforeCount).toBe(1);
    const jobs = site.store.listScheduled(SITE_ID);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("published");
  });

  it("fails cleanly with a recorded reason when content no longer validates or the site was deleted", async () => {
    await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: site.head(),
      action: "schedule",
      publishAt: futureLocal(),
      "f[heading]": "invalid-later",
    });
    const validationJob = site.store.listScheduled(SITE_ID)[0]!;

    // Change schema so `subtitle` is now required, invalidating the scheduled form.
    site.write(
      ".cms/schema.yaml",
      `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text, required: true }
      subtitle: { type: text, required: true }
`,
    );

    const future = afterDue();
    await site.app.runDueSchedules(future);

    const settledValidation = site.store.getScheduled(validationJob.id)!;
    expect(settledValidation.status).toBe("failed");
    expect(settledValidation.detail).toContain("no longer passes validation");

    // Schedule another job, then delete the site folder on disk.
    await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: site.head(),
      action: "schedule",
      publishAt: futureLocal(),
      "f[heading]": "Valid",
      "f[subtitle]": "Also valid",
    });
    const deletedSiteJob = site.store
      .listScheduled(SITE_ID)
      .find((j) => j.id !== validationJob.id)!;

    rmSync(site.root, { recursive: true, force: true });
    await site.app.runDueSchedules(future);

    const settledDeleted = site.store.getScheduled(deletedSiteJob.id)!;
    expect(settledDeleted.status).toBe("failed");
    expect(settledDeleted.detail).toBeTruthy();
  });

  it("cancelling a job that is already running cannot double-publish", async () => {
    await post(site, `/sites/${SITE_ID}/regions/home.hero`, {
      headSha: "",
      action: "schedule",
      publishAt: futureLocal(),
      "f[heading]": "In flight",
    });
    const job = site.store.listScheduled(SITE_ID)[0]!;
    const beforeCount = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: site.root,
        encoding: "utf8",
      }),
    );

    const future = afterDue();
    const runningPromise = site.app.runDueSchedules(future);
    // Synchronously claimed as `running` before the first await inside `runDueSchedules`.
    expect(site.store.getScheduled(job.id)?.status).toBe("running");

    const cancelRes = await post(site, `/sites/${SITE_ID}/scheduled/${job.id}/cancel`, {});
    expect(cancelRes.status).toBe(303);

    await runningPromise;
    await site.app.runDueSchedules(future);

    const afterCount = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: site.root,
        encoding: "utf8",
      }),
    );
    expect(afterCount - beforeCount).toBeLessThanOrEqual(1);
    expect(site.store.getScheduled(job.id)?.status).toBe("cancelled");
  });
});

describe("property 6: rollback requests", () => {
  const EXISTING = "a".repeat(40);
  let deployRoot: string;

  beforeEach(() => {
    deployRoot = makeTempDir("greatcms-rollback-root-");
    mkdirSync(join(deployRoot, "releases", EXISTING), { recursive: true });
    site.store.updateSite(SITE_ID, {
      name: "Example",
      devUrl: "",
      pushAfterPublish: false,
      deployRoot,
    });
  });

  it("accepts only a release id that exists in the builder folder and refuses paths, '..', or options", async () => {
    for (const invalid of [
      "..",
      "../..",
      `../releases/${EXISTING}`,
      `/releases/${EXISTING}`,
      "../../etc/passwd",
      "--help",
      "-f",
      "--output=/tmp/pwn",
      "b".repeat(40),
      EXISTING.slice(0, 7),
      EXISTING.toUpperCase(),
      "",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential check of invalid rollback shas
      expect(await requestRollback(deployRoot, invalid)).toBe(false);
      // oxlint-disable-next-line no-await-in-loop -- sequential check of invalid rollback shas
      const res = await post(site, `/sites/${SITE_ID}/rollback`, { sha: invalid });
      expect(res.status).toBe(404);
      expect(existsSync(join(deployRoot, "rollback"))).toBe(false);
    }

    const okRes = await post(site, `/sites/${SITE_ID}/rollback`, { sha: EXISTING });
    expect(okRes.status).toBe(303);
    expect(readFileSync(join(deployRoot, "rollback"), "utf8").trim()).toBe(EXISTING);
  });
});
