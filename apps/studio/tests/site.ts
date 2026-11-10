/** A real site in a temp folder, which is the only kind the studio manages. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "../src/app.js";
import { createSessionCookie, sessionKey } from "../src/auth.js";
import { Store } from "../src/db.js";

export const PASSWORD = "test-password";
export const SECRET = "test-secret";
export const SITE_ID = "site-1";

export const signedIn = {
  cookie: createSessionCookie(sessionKey(SECRET, PASSWORD)).split(";")[0] as string,
};

/** The same session as a browser holds it over HTTPS. */
export const signedInSecure = {
  cookie: createSessionCookie(sessionKey(SECRET, PASSWORD), { secure: true }).split(
    ";",
  )[0] as string,
};

export interface Fixture {
  root: string;
  store: Store;
  app: ReturnType<typeof createApp>;
  /** Writes a file into the site, creating directories as needed. */
  write(path: string, content: string): void;
  read(path: string): string;
  exists(path: string): boolean;
  /** The commit the working copy is on. */
  head(): string;
  git(args: string[]): void;
  /** Writes a file and commits it, so a later change is a real change. */
  commit(path: string, content: string): void;
  cleanup(): void;
}

export interface FixtureOptions {
  schema: string;
  config?: string;
  files?: Record<string, string>;
  devUrl?: string;
  /** Skip `git init`, for the "a folder that is not a repository" case. */
  git?: boolean;
}

export function makeSite(options: FixtureOptions): Fixture {
  const root = mkdtempSync(join(tmpdir(), "greatcms-"));

  const write = (path: string, content: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  write(".cms/schema.yaml", options.schema);
  write(".cms/config.yaml", options.config ?? "version: 1\n");
  for (const [path, content] of Object.entries(options.files ?? {})) write(path, content);

  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  if (options.git !== false) {
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "initial"]);
  }

  const store = new Store(":memory:");
  store.addSite({
    id: SITE_ID,
    name: "Example",
    path: root,
    devUrl: options.devUrl ?? "",
    createdAt: "2026-08-16",
  });

  return {
    root,
    store,
    app: createApp({ store, password: PASSWORD, secret: SECRET }),
    write,
    read: (path) => readFileSync(join(root, path), "utf8"),
    exists: (path) => {
      try {
        readFileSync(join(root, path));
        return true;
      } catch {
        return false;
      }
    },
    head: () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    git,
    commit: (path, content) => {
      write(path, content);
      git(["add", "-A"]);
      git(["commit", "-qm", `seed ${path}`]);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A form POST, the way every mutation in this app arrives. */
export function post(
  fixture: Fixture,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = signedIn,
) {
  return fixture.app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

export function get(fixture: Fixture, path: string, headers: Record<string, string> = signedIn) {
  return fixture.app.request(path, { headers });
}
