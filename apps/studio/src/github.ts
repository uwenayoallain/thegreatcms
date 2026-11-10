/**
 * Connecting GitHub through a GitHub App the studio creates for itself. GitHub's manifest flow
 * makes the app in two clicks and hands its key straight back; the owner then chooses which
 * repositories it may reach. Every clone and push gets a token that lasts an hour, sent in that
 * one command's environment, so no credential is written into a repository or onto a command line.
 */

import { createSign, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface GitHubAppConfig {
  id: number;
  slug: string;
  clientId: string;
  pem: string;
  /** The app's page on GitHub, e.g. https://github.com/apps/greatcms-studio-ab12. */
  htmlUrl: string;
  /** The account that owns the app, and whether it is an organization. */
  owner: string;
  ownerType: "User" | "Organization";
  /** That account's id on GitHub, which a renamed or reused login does not change. */
  ownerId?: number;
  /** What proves a sign-in came through this app. Absent on an app made before sign-in existed. */
  clientSecret?: string;
}

/** A person as GitHub describes them at sign-in: no email is asked for, and none is kept. */
export interface GitHubPerson {
  id: number;
  login: string;
  name: string;
}

export interface Installation {
  id: number;
  account: string;
}

export interface Repository {
  fullName: string;
  name: string;
  owner: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string;
  /** The installation that reaches it, for asking GitHub about its files. */
  installationId?: number;
}

/**
 * A name people recognise on GitHub's screens, which must also be unique across GitHub: the
 * studio's own host when it has a public one, and a short random tag on localhost or an address.
 */
export function appName(origin: string): string {
  const host = new URL(origin).hostname;
  const local = host === "localhost" || host.endsWith(".localhost") || /^[\d.:[\]]+$/.test(host);
  const named = `GreatCMS ${host}`;
  return !local && named.length <= 34 ? named : `GreatCMS Studio ${randomBytes(2).toString("hex")}`;
}

/** What GitHub shows on the app's page and when someone installs it; GitHub renders it as Markdown. */
export function appDescription(origin: string): string {
  return [
    `The visual editor at **${new URL(origin).host}** for sites whose content lives in Git.`,
    "",
    "- Signs you in with your GitHub account",
    "- Adds the repositories you choose as sites",
    "- Publishes each edit as one commit",
    "",
    "It reads and writes files in those repositories and nothing else: no issues, settings, secrets or webhooks. It never runs their code.",
    "",
    "Open source: github.com/uwenayoallain/thegreatcms",
  ].join("\n");
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** Creations waiting for GitHub to send the browser back; the oldest is dropped past this. */
const MAX_STATES = 20;

/** The most repositories looked into for a schema on one page. */
const MAX_SCHEMA_CHECKS = 300;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The least an app needs to clone and push: file contents, and metadata GitHub always grants. */
export const PERMISSIONS = { contents: "write", metadata: "read" } as const;

/** Where GitHub sends a person back after they sign in. */
export const SIGN_IN_CALLBACK = "/sign-in/github/callback";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})$/;
const SECRET = /^[A-Za-z0-9_-]{20,255}$/;

export class GitHub {
  /** Where GitHub's API lives: api.github.com, or /api/v3 on GitHub Enterprise Server. */
  readonly api: string;
  private readonly states = new Map<string, number>();
  private readonly tokens = new Map<number, { token: Promise<string>; until: number }>();
  private listed: { at: number; value: Promise<Repository[]> } | undefined;
  private installed: { at: number; value: Promise<Installation[]> } | undefined;
  private readonly schemas = new Map<string, { at: number; value: Promise<boolean> }>();

  constructor(
    private readonly file: string,
    /** Where people use GitHub: https://github.com, or a GitHub Enterprise Server address. */
    readonly web = "https://github.com",
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.web = web.replace(/\/+$/, "");
    this.api = this.web === "https://github.com" ? "https://api.github.com" : `${this.web}/api/v3`;
  }

  config(): GitHubAppConfig | null {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as GitHubAppConfig;
    } catch {
      return null;
    }
  }

  /**
   * What the browser posts to GitHub to create the app: the form's address and the manifest.
   * `origin` is where browsers reach this studio, which GitHub sends them back to.
   */
  creation(origin: string, organization?: string): { action: string; manifest: string } {
    const state = randomBytes(24).toString("base64url");
    const now = Date.now();
    for (const [key, until] of this.states) if (until < now) this.states.delete(key);
    while (this.states.size >= MAX_STATES) {
      this.states.delete(this.states.keys().next().value as string);
    }
    this.states.set(state, now + 60 * 60_000);
    const manifest = {
      name: appName(origin),
      url: origin,
      description: appDescription(origin),
      request_oauth_on_install: false,
      redirect_url: `${origin}/git-access/github/created`,
      callback_urls: [`${origin}${SIGN_IN_CALLBACK}`],
      setup_url: `${origin}/git-access/github/installed`,
      setup_on_update: true,
      public: false,
      default_permissions: PERMISSIONS,
      default_events: [],
      hook_attributes: { url: `${origin}/git-access/github`, active: false },
    };
    const owner = organization
      ? `/organizations/${encodeURIComponent(organization)}/settings/apps/new`
      : "/settings/apps/new";
    return {
      action: `${this.web}${owner}?state=${encodeURIComponent(state)}`,
      manifest: JSON.stringify(manifest),
    };
  }

  /** GitHub sent the browser back with a code: trade it for the app's key, once, within the hour. */
  async finishCreation(code: string, state: string): Promise<GitHubAppConfig> {
    const until = this.states.get(state);
    this.states.delete(state);
    if (!until || until < Date.now()) {
      throw new GitHubError("That GitHub link has expired or was not started here. Start again.");
    }
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new GitHubError("GitHub sent no usable code.");
    const made = (await this.request(`/app-manifests/${code}/conversions`, {
      method: "POST",
    })) as {
      id: number;
      slug: string;
      client_id: string;
      pem: string;
      html_url: string;
      client_secret?: string;
      owner?: { login?: string; type?: string; id?: number };
    };
    // The answer is kept and later followed, so it has to be an app on this GitHub and nothing else.
    if (
      !Number.isSafeInteger(made.id) ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(String(made.slug)) ||
      typeof made.pem !== "string" ||
      !String(made.html_url).startsWith(`${this.web}/`)
    ) {
      throw new GitHubError("GitHub's answer did not describe an app this studio can use.");
    }
    const config: GitHubAppConfig = {
      id: made.id,
      slug: made.slug,
      clientId: made.client_id,
      pem: made.pem,
      htmlUrl: made.html_url,
      owner: made.owner?.login ?? "",
      ownerType: made.owner?.type === "Organization" ? "Organization" : "User",
      ownerId: Number.isSafeInteger(made.owner?.id) ? made.owner?.id : undefined,
      clientSecret: SECRET.test(String(made.client_secret)) ? made.client_secret : undefined,
    };
    this.write(config);
    this.forget();
    return config;
  }

  private write(config: GitHubAppConfig): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.file), 0o700);
    // Whole or not at all, and never readable by anyone else on the way.
    const temporary = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.file);
  }

  /** Whether people can sign in through the app: it has to hold the app's client secret. */
  signIn(): boolean {
    return Boolean(this.config()?.clientSecret);
  }

  /** GitHub's page asking a person to sign in to this studio. */
  authorizeUrl(redirectUri: string, state: string, challenge: string): string | null {
    const config = this.config();
    if (!config?.clientSecret) return null;
    const query = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${this.web}/login/oauth/authorize?${query}`;
  }

  /**
   * Trades the code GitHub sent back for who signed in, then gives the person's token up: nothing
   * after this needs it, since the app's own installation answers what they may open.
   */
  async identify(code: string, redirectUri: string, verifier: string): Promise<GitHubPerson> {
    const config = this.config();
    if (!config?.clientSecret) throw new GitHubError("Signing in with GitHub is not set up.");
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new GitHubError("GitHub sent no usable code.");
    let token: unknown;
    try {
      const response = await this.fetcher(`${this.web}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "greatcms-studio",
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      token = ((await response.json()) as { access_token?: unknown }).access_token;
    } catch {
      throw new GitHubError(`This studio could not reach ${new URL(this.web).host}.`);
    }
    if (typeof token !== "string" || !SECRET.test(token)) {
      throw new GitHubError("GitHub did not accept that sign-in. Start again.");
    }
    try {
      const user = (await this.request("/user", { bearer: token })) as {
        id?: number;
        login?: string;
        name?: string | null;
        type?: string;
      };
      if (
        !Number.isSafeInteger(user.id) ||
        !LOGIN.test(String(user.login)) ||
        user.type !== "User"
      ) {
        throw new GitHubError("GitHub's answer did not describe a person.");
      }
      const name = typeof user.name === "string" ? user.name.replace(/\s+/g, " ").trim() : "";
      return { id: user.id as number, login: user.login as string, name: name.slice(0, 80) };
    } finally {
      void this.revoke(config, token);
    }
  }

  /** Ends a person's token at GitHub; if that fails it still expires there on its own. */
  private async revoke(config: GitHubAppConfig, token: string): Promise<void> {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    await this.fetcher(`${this.api}/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        "user-agent": "greatcms-studio",
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined);
  }

  /**
   * Whether GitHub lets this person push to a repository the app was given. Asked with the app's
   * installation token, and matched on the account's id: a login can be renamed and taken again.
   */
  async canPush(remoteUrl: string, person: { id: number; login: string }): Promise<boolean> {
    const repository = this.repositoryOf(remoteUrl);
    if (!this.config() || !repository || !LOGIN.test(person.login)) return false;
    const installation = (await this.installations()).find(
      (entry) => entry.account.toLowerCase() === repository.owner.toLowerCase(),
    );
    if (!installation) return false;
    // A public repository answers anyone; only one the app was given counts.
    const wanted = `${repository.owner}/${repository.name}`.toLowerCase();
    const given = (await this.repositories()).some(
      (entry) => entry.fullName.toLowerCase() === wanted,
    );
    if (!given) return false;
    const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/collaborators/${encodeURIComponent(person.login)}/permission`;
    let answer: { permission?: string; role_name?: string; user?: { id?: number } };
    try {
      answer = (await this.request(path, {
        token: await this.token(installation.id),
      })) as typeof answer;
    } catch (error) {
      // Not a collaborator, not a repository the app was given, or an account that is gone.
      if (error instanceof GitHubError && (error.status === 404 || error.status === 403)) {
        return false;
      }
      throw error;
    }
    if (answer.user?.id !== person.id) return false;
    return ["admin", "maintain", "write"].some(
      (level) => answer.permission === level || answer.role_name === level,
    );
  }

  /** Where the owner picks the accounts and repositories the app may reach. */
  installUrl(): string | null {
    const config = this.config();
    // The file is the studio's own, but the browser is sent here: only ever to this GitHub.
    if (!config || !String(config.htmlUrl).startsWith(`${this.web}/`)) return null;
    return `${config.htmlUrl}/installations/new`;
  }

  /** Where the app itself is deleted on GitHub, which only its owner can do. */
  settingsUrl(): string | null {
    const config = this.config();
    if (!config) return null;
    const slug = encodeURIComponent(config.slug);
    return config.ownerType === "Organization"
      ? `${this.web}/organizations/${encodeURIComponent(config.owner)}/settings/apps/${slug}`
      : `${this.web}/settings/apps/${slug}`;
  }

  /** The accounts the app is installed on; asked again after a minute. */
  installations(): Promise<Installation[]> {
    if (this.installed && Date.now() - this.installed.at < 60_000) return this.installed.value;
    const value = this.request("/app/installations?per_page=100", { app: true }).then((found) =>
      (found as Array<{ id: number; account?: { login?: string } }>).map((entry) => ({
        id: entry.id,
        account: entry.account?.login ?? "",
      })),
    );
    this.installed = { at: Date.now(), value };
    value.catch(() => (this.installed = undefined));
    return value;
  }

  /** Every repository the app was given, across accounts; asked again after a minute. */
  repositories(): Promise<Repository[]> {
    if (this.listed && Date.now() - this.listed.at < 60_000) return this.listed.value;
    const value = this.listRepositories();
    this.listed = { at: Date.now(), value };
    value.catch(() => (this.listed = undefined));
    return value;
  }

  private async listRepositories(): Promise<Repository[]> {
    const lists = await Promise.all(
      (await this.installations()).map((installation) =>
        this.installationRepositories(installation),
      ),
    );
    return lists.flat().toSorted((a, b) => a.fullName.localeCompare(b.fullName));
  }

  private async installationRepositories(installation: Installation): Promise<Repository[]> {
    const token = await this.token(installation.id);
    const all: Repository[] = [];
    for (let page = 1; page <= 50; page++) {
      // oxlint-disable-next-line no-await-in-loop -- each page is only asked for if the last was full
      const answer = (await this.request(`/installation/repositories?per_page=100&page=${page}`, {
        token,
      })) as {
        repositories: Array<{
          full_name: string;
          name: string;
          owner: { login: string };
          clone_url: string;
          private: boolean;
          default_branch: string;
        }>;
      };
      for (const repo of answer.repositories) {
        all.push({
          fullName: repo.full_name,
          name: repo.name,
          owner: repo.owner.login,
          cloneUrl: repo.clone_url,
          private: repo.private,
          defaultBranch: repo.default_branch,
          installationId: installation.id,
        });
      }
      if (answer.repositories.length < 100) break;
    }
    return all;
  }

  /** The repositories among these that already hold a GreatCMS schema, by full name. */
  async withSchema(repositories: Repository[]): Promise<Set<string>> {
    const queue = repositories.slice(0, MAX_SCHEMA_CHECKS);
    const found = new Set<string>();
    const worker = async () => {
      for (let repo = queue.shift(); repo; repo = queue.shift()) {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time, so GitHub is not flooded
        if (await this.hasSchema(repo).catch(() => false)) found.add(repo.fullName);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return found;
  }

  /** Whether a repository has `.cms/schema.*` on its main branch; asked again after ten minutes. */
  private hasSchema(repo: Repository): Promise<boolean> {
    const known = this.schemas.get(repo.fullName);
    if (known && Date.now() - known.at < 10 * 60_000) return known.value;
    const value = (async () => {
      if (repo.installationId === undefined) return false;
      const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/.cms`;
      try {
        const entries = await this.request(path, { token: await this.token(repo.installationId) });
        return (
          Array.isArray(entries) &&
          entries.some(
            (entry: { type?: string; name?: string }) =>
              entry?.type === "file" && /^schema\.(?:ya?ml|json)$/.test(String(entry.name)),
          )
        );
      } catch (error) {
        // No such folder, or a repository with no commits yet.
        if (error instanceof GitHubError && error.status === 404) return false;
        throw error;
      }
    })();
    this.schemas.set(repo.fullName, { at: Date.now(), value });
    value.catch(() => this.schemas.delete(repo.fullName));
    return value;
  }

  /**
   * Git config that signs one command in to a repository on this GitHub, or none when the app
   * cannot reach it. SSH addresses are fetched over https instead, where the token works.
   */
  async gitConfigFor(remoteUrl: string): Promise<Array<[string, string]>> {
    if (!this.config()) return [];
    const owner = this.ownerOf(remoteUrl);
    if (!owner) return [];
    const installation = (await this.installations()).find(
      (entry) => entry.account.toLowerCase() === owner.toLowerCase(),
    );
    if (!installation) return [];
    const token = await this.token(installation.id);
    const host = new URL(this.web).host;
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return [
      [`http.${this.web}/.extraheader`, `AUTHORIZATION: basic ${basic}`],
      // git keeps sending the header to wherever a redirect leads, so none is followed.
      [`http.${this.web}/.followRedirects`, "false"],
      [`url.${this.web}/.insteadOf`, `git@${host}:`],
      [`url.${this.web}/.insteadOf`, `ssh://git@${host}/`],
    ];
  }

  /** The account a repository address belongs to, when it is on this GitHub. */
  ownerOf(remoteUrl: string): string | null {
    return this.repositoryOf(remoteUrl)?.owner ?? null;
  }

  /** The account and name of a repository address, when it is on this GitHub. */
  repositoryOf(remoteUrl: string): { owner: string; name: string } | null {
    const host = escapeRegExp(new URL(this.web).host);
    const scheme = new URL(this.web).protocol.replace(":", "");
    const match =
      new RegExp(`^${scheme}://(?:[^@/]+@)?${host}/([^/]+)/([^/]+?)(?:\\.git)?/?$`, "i").exec(
        remoteUrl,
      ) ??
      new RegExp(`^(?:ssh://)?git@${host}[:/]([^/]+)/([^/]+?)(?:\\.git)?/?$`, "i").exec(remoteUrl);
    return match ? { owner: match[1] as string, name: match[2] as string } : null;
  }

  /** Removes the app from every account it was installed on, then forgets it here. */
  async disconnect(): Promise<void> {
    if (this.config()) {
      const installations = await this.installations().catch(() => []);
      await Promise.all(
        installations.map((entry) =>
          this.request(`/app/installations/${entry.id}`, { method: "DELETE", app: true }).catch(
            () => undefined,
          ),
        ),
      );
    }
    rmSync(this.file, { force: true });
    this.forget();
  }

  /** Drops what was asked of GitHub, after a change there such as a new installation. */
  forget(): void {
    this.tokens.clear();
    this.listed = undefined;
    this.installed = undefined;
    this.schemas.clear();
  }

  /** An installation token, reused until five minutes before it expires; one request at a time. */
  private token(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.until > Date.now()) return cached.token;
    const token = this.request(`/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      app: true,
    }).then((made) => {
      const { token: value, expires_at } = made as { token: string; expires_at: string };
      this.tokens.set(installationId, {
        token: Promise.resolve(value),
        until: new Date(expires_at).getTime() - 5 * 60_000,
      });
      return value;
    });
    // Asked for again by everyone at once while it is on its way, and dropped if it fails.
    this.tokens.set(installationId, { token, until: Date.now() + 60_000 });
    token.catch(() => this.tokens.delete(installationId));
    return token;
  }

  /** A JSON Web Token proving the request comes from the app, good for nine minutes. */
  appJwt(now = Math.floor(Date.now() / 1000)): string {
    const config = this.config();
    if (!config) throw new GitHubError("GitHub is not connected.");
    // A minute back, because GitHub's clock and this machine's are never quite the same.
    const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: config.clientId })}`;
    const signature = createSign("RSA-SHA256").update(body).sign(config.pem, "base64url");
    return `${body}.${signature}`;
  }

  private async request(
    path: string,
    options: { method?: string; app?: boolean; token?: string; bearer?: string } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "greatcms-studio",
    };
    if (options.app) headers.authorization = `Bearer ${this.appJwt()}`;
    if (options.token) headers.authorization = `token ${options.token}`;
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
    let response: Response;
    try {
      response = await this.fetcher(`${this.api}${path}`, {
        method: options.method ?? "GET",
        headers,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GitHubError(`This studio could not reach ${new URL(this.api).host}.`);
    }
    if (response.status === 204) return null;
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) {
      const message =
        response.status === 401
          ? "GitHub no longer accepts this studio's app: it may have been deleted. Disconnect and connect again."
          : response.status === 404 && options.app
            ? "GitHub no longer has this app, or it was removed from that account."
            : `GitHub answered ${response.status}${body.message ? `: ${body.message}` : ""}.`;
      throw new GitHubError(message, response.status);
    }
    return body;
  }
}
