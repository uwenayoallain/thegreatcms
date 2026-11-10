/**
 * Access tokens for Git hosts other than GitHub, which connects through its app instead: kept in
 * git's own credential store, and reaching every git the studio runs through environment config,
 * so cloning and pushing after a publish use them alike.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SavedToken {
  host: string;
  username: string;
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
const USERNAME = /^[A-Za-z0-9._-]{1,100}$/;
const TOKEN = /^[\x21-\x7e]{8,1000}$/;

/** The user name each host expects beside a token; any other host needs one given. */
export function tokenUser(host: string): string | null {
  if (host === "github.com" || host.endsWith(".ghe.com")) return "x-access-token";
  if (host === "gitlab.com" || host.startsWith("gitlab.")) return "oauth2";
  if (host === "bitbucket.org") return "x-token-auth";
  return null;
}

export class GitAccess {
  private readonly base: Array<[string, string]>;
  /** How many entries the last apply set, so a removed one is cleared. */
  private applied = 0;

  constructor(
    private readonly dir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    // Config already in the environment, such as the image's safe.directory, is kept.
    const count = Number(env.GIT_CONFIG_COUNT ?? 0);
    this.base = Array.from({ length: Number.isFinite(count) ? count : 0 }, (_, index) => [
      env[`GIT_CONFIG_KEY_${index}`] ?? "",
      env[`GIT_CONFIG_VALUE_${index}`] ?? "",
    ]);
    this.apply();
  }

  private get credentialsFile() {
    return join(this.dir, "git-credentials");
  }

  tokens(): SavedToken[] {
    return this.lines().flatMap((line) => {
      try {
        const url = new URL(line);
        return [{ host: url.host, username: decodeURIComponent(url.username) }];
      } catch {
        return [];
      }
    });
  }

  /** Saves a token for a host, replacing one saved before. Returns a problem, or null. */
  saveToken(hostInput: string, usernameInput: string, token: string): string | null {
    const host = hostInput
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!HOST.test(host)) return "Give the host name only, such as github.com.";
    const username = usernameInput.trim() || tokenUser(host);
    if (!username) return `Give the user name ${host} expects with a token.`;
    if (!USERNAME.test(username)) return "The user name has characters git cannot send.";
    if (!TOKEN.test(token.trim())) return "That does not look like a token: paste it whole.";
    const line = `https://${encodeURIComponent(username)}:${encodeURIComponent(token.trim())}@${host}`;
    this.write([...this.lines().filter((existing) => hostOf(existing) !== host), line]);
    return null;
  }

  removeToken(host: string): void {
    this.write(this.lines().filter((line) => hostOf(line) !== host));
  }

  /** Points every git this process starts at the tokens, when there are any. */
  apply(): void {
    const entries = [...this.base];
    if (this.lines().length > 0) {
      entries.push(["credential.helper", `store --file=${quote(this.credentialsFile)}`]);
    }
    for (let index = 0; index < Math.max(entries.length, this.applied); index++) {
      delete this.env[`GIT_CONFIG_KEY_${index}`];
      delete this.env[`GIT_CONFIG_VALUE_${index}`];
    }
    entries.forEach(([key, value], index) => {
      this.env[`GIT_CONFIG_KEY_${index}`] = key;
      this.env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    if (entries.length) this.env.GIT_CONFIG_COUNT = String(entries.length);
    else delete this.env.GIT_CONFIG_COUNT;
    this.applied = entries.length;
  }

  private lines(): string[] {
    try {
      return readFileSync(this.credentialsFile, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  private write(lines: string[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    // Replaced whole: a stop halfway through must not leave half the tokens, or a readable file.
    const temporary = `${this.credentialsFile}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, lines.length ? `${lines.join("\n")}\n` : "", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, this.credentialsFile);
    this.apply();
  }
}

function hostOf(line: string): string | null {
  try {
    return new URL(line).host;
  } catch {
    return null;
  }
}

/** A path as one word for git's shell. */
function quote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}
