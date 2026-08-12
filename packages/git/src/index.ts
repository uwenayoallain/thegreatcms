/**
 * @greatcms/git — write content to GitHub as atomic commits.
 *
 * Deliberately not an SDK wrapper: it is a few hundred lines of `fetch` against
 * documented endpoints, which keeps the studio small and portable to any
 * runtime that has `fetch` (Node, Workers, Deno, Bun).
 *
 * The important decision is using the **Git Data API** rather than repeated
 * `PUT /repos/.../contents/{path}` calls. Contents-API writes are one commit per
 * file, so publishing a region plus three images is four commits that can
 * half-apply — and half-applied content is how `main` stops building. Here a
 * publish is: blobs → tree → commit → ref update. One commit, all or nothing.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface FileChange {
  /** Repo-relative path, e.g. `content/cms/home.hero.json`. */
  path: string;
  /** UTF-8 text content. Mutually exclusive with `base64`. */
  content?: string;
  /** Base64 content, for binary files such as uploads. */
  base64?: string;
  /** Delete the path instead of writing it. */
  delete?: boolean;
}

export interface CommitRequest {
  branch: string;
  message: string;
  files: FileChange[];
  /**
   * The commit the editor started from. If the branch has moved since, the
   * publish is rejected rather than silently overwriting someone else's work.
   */
  expectedHeadSha?: string;
  author?: { name: string; email: string };
}

export interface CommitResult {
  commitSha: string;
  treeSha: string;
  branch: string;
  url: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    message: string,
    readonly hint?: string,
  ) {
    super(hint ? `${message}\n  fix: ${hint}` : message);
    this.name = "GitHubError";
  }
}

/** Raised when the branch moved between loading and publishing. */
export class ConflictError extends GitHubError {
  constructor(
    readonly branch: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      409,
      `refs/heads/${branch}`,
      `The branch "${branch}" moved while you were editing (expected ${short(expected)}, found ${short(actual)}).`,
      "Reload the region to pick up the newer content, then publish again.",
    );
    this.name = "ConflictError";
  }
}

export interface GitHubClientOptions {
  /** Installation token, PAT, or any bearer the API accepts. */
  token: string;
  /** Injected for tests and non-Node runtimes. */
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  userAgent?: string;
}

export class GitHubClient {
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.userAgent = options.userAgent ?? "greatcms";
  }

  /** Reads a UTF-8 file. Returns null when it does not exist. */
  async getFile(
    repo: RepoRef,
    path: string,
    ref?: string,
  ): Promise<{ content: string; sha: string } | null> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const response = await this.request(
      "GET",
      `/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}${query}`,
      undefined,
      { allow404: true },
    );
    if (response === null) return null;

    const body = response as { content?: string; encoding?: string; sha: string; type: string };
    if (body.type !== "file" || typeof body.content !== "string") return null;
    return {
      content: decodeBase64(body.content.replace(/\n/g, "")),
      sha: body.sha,
    };
  }

  /** Lists file paths under a directory (non-recursive). */
  async listDirectory(repo: RepoRef, path: string, ref?: string): Promise<string[]> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const response = await this.request(
      "GET",
      `/repos/${repo.owner}/${repo.repo}/contents/${encodePath(path)}${query}`,
      undefined,
      { allow404: true },
    );
    if (!Array.isArray(response)) return [];
    return (response as Array<{ path: string; type: string }>)
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path);
  }

  async getBranchHead(repo: RepoRef, branch: string): Promise<string | null> {
    const ref = await this.request(
      "GET",
      `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${encodePath(branch)}`,
      undefined,
      { allow404: true },
    );
    if (!ref) return null;
    return (ref as { object: { sha: string } }).object.sha;
  }

  /**
   * Writes every file in one commit, or writes nothing at all.
   */
  async commitFiles(repo: RepoRef, request: CommitRequest): Promise<CommitResult> {
    if (request.files.length === 0) {
      throw new GitHubError(400, "commitFiles", "A commit needs at least one file change.");
    }

    const head = await this.getBranchHead(repo, request.branch);
    if (!head) {
      throw new GitHubError(
        404,
        `refs/heads/${request.branch}`,
        `Branch "${request.branch}" does not exist in ${repo.owner}/${repo.repo}.`,
        "Create the branch, or point the site at an existing one in .cms/config.yaml.",
      );
    }
    if (request.expectedHeadSha && request.expectedHeadSha !== head) {
      throw new ConflictError(request.branch, request.expectedHeadSha, head);
    }

    const baseCommit = (await this.request(
      "GET",
      `/repos/${repo.owner}/${repo.repo}/git/commits/${head}`,
    )) as { tree: { sha: string } };

    for (const file of request.files) {
      if (!file.delete && file.content === undefined && file.base64 === undefined) {
        throw new GitHubError(
          400,
          "commitFiles",
          `File "${file.path}" has no content.`,
          "Pass `content` for text, `base64` for binary, or `delete: true` to remove it.",
        );
      }
    }

    // Blobs go up in parallel: a publish with a region and three images is one
    // round trip's worth of latency rather than four. Uploading them separately
    // from the tree also lets binary content travel as base64 without
    // corrupting text files.
    const tree = await Promise.all(
      request.files.map(async (file) => {
        if (file.delete) {
          return { path: file.path, mode: "100644", type: "blob", sha: null };
        }
        const blob = (await this.request("POST", `/repos/${repo.owner}/${repo.repo}/git/blobs`, {
          content: file.base64 ?? file.content,
          encoding: file.base64 ? "base64" : "utf-8",
        })) as { sha: string };
        return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
      }),
    );

    const newTree = (await this.request("POST", `/repos/${repo.owner}/${repo.repo}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree,
    })) as { sha: string };

    const commit = (await this.request("POST", `/repos/${repo.owner}/${repo.repo}/git/commits`, {
      message: request.message,
      tree: newTree.sha,
      parents: [head],
      ...(request.author ? { author: request.author } : {}),
    })) as { sha: string; html_url?: string };

    // force: false — if the branch moved between the check above and now, the
    // update is refused rather than discarding the other commit.
    await this.request(
      "PATCH",
      `/repos/${repo.owner}/${repo.repo}/git/refs/heads/${encodePath(request.branch)}`,
      { sha: commit.sha, force: false },
    );

    return {
      commitSha: commit.sha,
      treeSha: newTree.sha,
      branch: request.branch,
      url: commit.html_url ?? `https://github.com/${repo.owner}/${repo.repo}/commit/${commit.sha}`,
    };
  }

  /** Creates a branch from another branch, or returns the existing head. */
  async ensureBranch(repo: RepoRef, branch: string, fromBranch: string): Promise<string> {
    const existing = await this.getBranchHead(repo, branch);
    if (existing) return existing;

    const source = await this.getBranchHead(repo, fromBranch);
    if (!source) {
      throw new GitHubError(
        404,
        `refs/heads/${fromBranch}`,
        `Cannot branch from "${fromBranch}": it does not exist.`,
      );
    }
    await this.request("POST", `/repos/${repo.owner}/${repo.repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: source,
    });
    return source;
  }

  /** For pipelines that need an explicit nudge rather than a push trigger. */
  async dispatch(
    repo: RepoRef,
    eventType: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.request("POST", `/repos/${repo.owner}/${repo.repo}/dispatches`, {
      event_type: eventType,
      ...(payload ? { client_payload: payload } : {}),
    });
  }

  private async request(
    method: string,
    endpoint: string,
    body?: unknown,
    options: { allow404?: boolean } = {},
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": this.userAgent,
        "x-github-api-version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 404 && options.allow404) return null;

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GitHubError(
        response.status,
        endpoint,
        `GitHub said ${response.status} for ${method} ${endpoint}${text ? `: ${firstLine(text)}` : "."}`,
        hintFor(response.status),
      );
    }

    if (response.status === 204) return null;
    return response.json();
  }
}

function hintFor(status: number): string | undefined {
  switch (status) {
    case 401:
      return "The token is missing, expired, or malformed.";
    case 403:
      return "The token lacks `contents: write` on this repository, or you are rate limited.";
    case 404:
      return "Check the owner/repo spelling, and that the token can see this repository.";
    case 409:
    case 422:
      return "The branch moved, or the ref update was rejected. Reload and publish again.";
    default:
      return undefined;
  }
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodeBase64(value: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  );
}

function firstLine(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (parsed.message) return parsed.message;
  } catch {
    // not JSON; fall through to the raw text
  }
  return text.split("\n")[0]?.slice(0, 200) ?? "";
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
