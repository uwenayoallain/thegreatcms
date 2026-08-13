import { describe, expect, it } from "vitest";
import { ConflictError, GitHubClient, GitHubError } from "./index.js";

const REPO = { owner: "ada", repo: "site" };

interface Call {
  method: string;
  path: string;
  /** Kept separate from `path` so responses stay keyed on the route alone. */
  query: string;
  body?: Record<string, unknown>;
}

/**
 * A stand-in for the parts of the GitHub API we use. Recording calls is the
 * point: the guarantee worth testing is *how many* commits a publish produces
 * and in what order, not that fetch works.
 */
function fakeGitHub(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  let blobCounter = 0;

  const responses: Record<string, unknown> = {
    "GET /repos/ada/site/git/ref/heads/main": { object: { sha: "head-sha" } },
    "GET /repos/ada/site/git/commits/head-sha": { tree: { sha: "base-tree" } },
    "POST /repos/ada/site/git/trees": { sha: "new-tree" },
    "POST /repos/ada/site/git/commits": { sha: "new-commit", html_url: "https://gh/commit" },
    "PATCH /repos/ada/site/git/refs/heads/main": { ref: "refs/heads/main" },
    ...overrides,
  };

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, query: parsed.search, body });

    if (method === "POST" && path.endsWith("/git/blobs")) {
      blobCounter += 1;
      return json({ sha: `blob-${blobCounter}` });
    }

    const key = `${method} ${path}`;
    const value = responses[key];
    if (value === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    if (value instanceof Response) return value.clone();
    return json(value);
  }) as unknown as typeof globalThis.fetch;

  return { calls, fetchImpl };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof globalThis.fetch) {
  return new GitHubClient({ token: "test-token", fetch: fetchImpl });
}

describe("commitFiles", () => {
  it("writes many files as exactly one commit", async () => {
    const { calls, fetchImpl } = fakeGitHub();

    const result = await client(fetchImpl).commitFiles(REPO, {
      branch: "main",
      message: "content: update home hero",
      files: [
        { path: "content/cms/home.hero.json", content: '{"heading":"Hi"}\n' },
        { path: "public/media/hero.webp", base64: "AAAA" },
      ],
    });

    expect(result.commitSha).toBe("new-commit");

    // The guarantee: one commit object, one ref update — never one per file.
    const commits = calls.filter((c) => c.path.endsWith("/git/commits") && c.method === "POST");
    const refUpdates = calls.filter((c) => c.method === "PATCH");
    expect(commits).toHaveLength(1);
    expect(refUpdates).toHaveLength(1);

    // And never the contents API, whose writes are one commit per file.
    expect(calls.some((c) => c.path.includes("/contents/") && c.method !== "GET")).toBe(false);
  });

  it("sends text as utf-8 and binary as base64", async () => {
    const { calls, fetchImpl } = fakeGitHub();
    await client(fetchImpl).commitFiles(REPO, {
      branch: "main",
      message: "mixed",
      files: [
        { path: "a.json", content: "{}" },
        { path: "b.webp", base64: "QUJD" },
      ],
    });

    const blobs = calls.filter((c) => c.path.endsWith("/git/blobs"));
    expect(blobs.map((c) => c.body?.encoding)).toEqual(["utf-8", "base64"]);
  });

  it("builds the tree on the current base tree so untouched files survive", async () => {
    const { calls, fetchImpl } = fakeGitHub();
    await client(fetchImpl).commitFiles(REPO, {
      branch: "main",
      message: "x",
      files: [{ path: "a.json", content: "{}" }],
    });

    const tree = calls.find((c) => c.path.endsWith("/git/trees"));
    expect(tree?.body?.base_tree).toBe("base-tree");
  });

  it("records a deletion as a null sha rather than an empty file", async () => {
    const { calls, fetchImpl } = fakeGitHub();
    await client(fetchImpl).commitFiles(REPO, {
      branch: "main",
      message: "remove",
      files: [{ path: "content/cms/old.json", delete: true }],
    });

    expect(calls.some((c) => c.path.endsWith("/git/blobs"))).toBe(false);
    const tree = calls.find((c) => c.path.endsWith("/git/trees"));
    const entries = tree?.body?.tree as Array<{ sha: unknown }> | undefined;
    expect(entries?.[0]?.sha).toBeNull();
  });

  it("never force-updates the ref", async () => {
    const { calls, fetchImpl } = fakeGitHub();
    await client(fetchImpl).commitFiles(REPO, {
      branch: "main",
      message: "x",
      files: [{ path: "a.json", content: "{}" }],
    });
    expect(calls.find((c) => c.method === "PATCH")?.body?.force).toBe(false);
  });

  it("refuses to publish when the branch moved under the editor", async () => {
    const { calls, fetchImpl } = fakeGitHub();

    await expect(
      client(fetchImpl).commitFiles(REPO, {
        branch: "main",
        message: "x",
        files: [{ path: "a.json", content: "{}" }],
        expectedHeadSha: "stale-sha",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Nothing was written: no blobs, no tree, no commit.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains a conflict in terms an editor can act on", async () => {
    const { fetchImpl } = fakeGitHub();
    const error = await client(fetchImpl)
      .commitFiles(REPO, {
        branch: "main",
        message: "x",
        files: [{ path: "a.json", content: "{}" }],
        expectedHeadSha: "stale-sha",
      })
      .catch((err: unknown) => err as ConflictError);

    expect(error.message).toContain("moved while you were editing");
    expect(error.message).toContain("Reload the region");
  });

  it("rejects a file with no content instead of committing an empty one", async () => {
    const { calls, fetchImpl } = fakeGitHub();
    await expect(
      client(fetchImpl).commitFiles(REPO, {
        branch: "main",
        message: "x",
        files: [{ path: "a.json" }],
      }),
    ).rejects.toThrow(/has no content/);
    expect(calls.some((c) => c.path.endsWith("/git/blobs"))).toBe(false);
  });

  it("rejects an empty publish", async () => {
    const { fetchImpl } = fakeGitHub();
    await expect(
      client(fetchImpl).commitFiles(REPO, { branch: "main", message: "x", files: [] }),
    ).rejects.toThrow(/at least one file/);
  });

  it("says which branch is missing", async () => {
    const { fetchImpl } = fakeGitHub({ "GET /repos/ada/site/git/ref/heads/main": undefined });
    await expect(
      client(fetchImpl).commitFiles(REPO, {
        branch: "main",
        message: "x",
        files: [{ path: "a.json", content: "{}" }],
      }),
    ).rejects.toThrow(/Branch "main" does not exist/);
  });
});

describe("reading", () => {
  it("decodes file content", async () => {
    const { fetchImpl } = fakeGitHub({
      "GET /repos/ada/site/contents/content/cms/home.hero.json": {
        type: "file",
        sha: "file-sha",
        encoding: "base64",
        content: Buffer.from('{"heading":"Hi"}').toString("base64"),
      },
    });

    const file = await client(fetchImpl).getFile(REPO, "content/cms/home.hero.json");
    expect(file).toEqual({ content: '{"heading":"Hi"}', sha: "file-sha" });
  });

  it("returns null for a file that does not exist, rather than throwing", async () => {
    const { fetchImpl } = fakeGitHub();
    expect(await client(fetchImpl).getFile(REPO, "content/cms/nope.json")).toBeNull();
  });

  it("lists only files in a directory", async () => {
    const { fetchImpl } = fakeGitHub({
      "GET /repos/ada/site/contents/content/cms": [
        { path: "content/cms/a.json", type: "file" },
        { path: "content/cms/nested", type: "dir" },
      ],
    });
    expect(await client(fetchImpl).listDirectory(REPO, "content/cms")).toEqual([
      "content/cms/a.json",
    ]);
  });
});

describe("errors", () => {
  it("turns a 403 into something actionable", async () => {
    const { fetchImpl } = fakeGitHub({
      "GET /repos/ada/site/git/ref/heads/main": new Response(
        '{"message":"Resource not accessible by integration"}',
        { status: 403 },
      ),
    });

    const error = await client(fetchImpl)
      .getBranchHead(REPO, "main")
      .catch((err: unknown) => err as GitHubError);

    expect(error).toBeInstanceOf(GitHubError);
    expect(error.status).toBe(403);
    expect(error.message).toContain("contents: write");
  });
});

describe("ensureBranch", () => {
  it("creates a draft branch from the publish branch", async () => {
    const { calls, fetchImpl } = fakeGitHub({
      "POST /repos/ada/site/git/refs": { ref: "refs/heads/cms/draft-1" },
    });

    await client(fetchImpl).ensureBranch(REPO, "cms/draft-1", "main");

    const created = calls.find((c) => c.path.endsWith("/git/refs") && c.method === "POST");
    expect(created?.body).toEqual({ ref: "refs/heads/cms/draft-1", sha: "head-sha" });
  });

  it("leaves an existing branch alone", async () => {
    const { calls, fetchImpl } = fakeGitHub({
      "GET /repos/ada/site/git/ref/heads/cms/draft-1": { object: { sha: "draft-head" } },
    });

    expect(await client(fetchImpl).ensureBranch(REPO, "cms/draft-1", "main")).toBe("draft-head");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("pull requests", () => {
  it("opens one when none is open for the branch", async () => {
    const { calls, fetchImpl } = fakeGitHub({
      "POST /repos/ada/site/pulls": {
        number: 7,
        html_url: "https://gh/pr/7",
        title: "Update hero",
      },
    });

    const pr = await client(fetchImpl).openOrUpdatePullRequest(REPO, {
      head: "cms/draft-home.hero",
      base: "main",
      title: "Update hero",
      body: "Changed heading.",
    });

    expect(pr).toEqual({
      number: 7,
      url: "https://gh/pr/7",
      title: "Update hero",
      created: true,
    });
    const opened = calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"));
    expect(opened?.body).toMatchObject({ head: "cms/draft-home.hero", base: "main" });
  });

  it("updates the open pull request instead of opening a second one", async () => {
    const { calls, fetchImpl } = fakeGitHub({
      "GET /repos/ada/site/pulls": [{ number: 7, html_url: "https://gh/pr/7", title: "Old title" }],
      "PATCH /repos/ada/site/pulls/7": {
        number: 7,
        html_url: "https://gh/pr/7",
        title: "New title",
      },
    });

    const pr = await client(fetchImpl).openOrUpdatePullRequest(REPO, {
      head: "cms/draft-home.hero",
      base: "main",
      title: "New title",
      body: "Changed again.",
    });

    expect(pr.created).toBe(false);
    expect(pr.title).toBe("New title");
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(false);
  });

  it("looks for the open pull request scoped to this repository's branch", async () => {
    const { calls, fetchImpl } = fakeGitHub({ "GET /repos/ada/site/pulls": [] });
    expect(await client(fetchImpl).findOpenPullRequest(REPO, "cms/draft-home.hero")).toBeNull();
    const lookup = calls.find((c) => c.path.includes("/pulls"));
    expect(lookup?.query).toContain("state=open");
    // Scoped to this owner, so a fork's branch of the same name cannot match.
    expect(decodeURIComponent(lookup?.query ?? "")).toContain("ada:cms/draft-home.hero");
  });
});
