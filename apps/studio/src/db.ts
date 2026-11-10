/** Storage. */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { UploadError, type UploadResult } from "./media.js";

export interface Site {
  id: string;
  name: string;
  /** Absolute path to the working copy. */
  path: string;
  /** Where the site's dev server is listening, so the editor can show the real components rendering. */
  devUrl: string;
  /** Push each publish to the branch's upstream, so it deploys without anyone touching Git. */
  pushAfterPublish: boolean;
  /** The builder's folder (`DEPLOY_ROOT`), so the studio can show what is live and roll back. */
  deployRoot: string;
  createdAt: string;
}

export type NewSite = Omit<Site, "createdAt" | "pushAfterPublish" | "deployRoot"> & {
  pushAfterPublish?: boolean;
  deployRoot?: string;
};

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: "001-sites",
    sql: `
      CREATE TABLE sites (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        owner      TEXT NOT NULL,
        repo       TEXT NOT NULL,
        branch     TEXT NOT NULL DEFAULT 'main',
        token      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX sites_repo ON sites (owner, repo, branch);
    `,
  },
  {
    name: "002-publishes",
    sql: `
      CREATE TABLE publishes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        region_id   TEXT NOT NULL,
        commit_sha  TEXT NOT NULL,
        commit_url  TEXT NOT NULL,
        actor       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX publishes_site ON publishes (site_id, created_at DESC);
    `,
  },
  {
    name: "003-submissions",
    sql: `
      CREATE TABLE submissions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        form         TEXT NOT NULL,
        data         TEXT NOT NULL,
        spam_score   INTEGER NOT NULL DEFAULT 0,
        spam_reasons TEXT NOT NULL DEFAULT '[]',
        read_at      TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX submissions_site ON submissions (site_id, id DESC);
      CREATE INDEX submissions_unread ON submissions (read_at) WHERE read_at IS NULL;
    `,
  },
  {
    name: "004-publish-mode",
    sql: `
      ALTER TABLE sites ADD COLUMN publish_mode TEXT NOT NULL DEFAULT 'direct';
      ALTER TABLE sites ADD COLUMN ai_titles INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE publishes ADD COLUMN pull_request_url TEXT;
    `,
  },
  {
    name: "005-local-sites",
    sql: `
      ALTER TABLE sites ADD COLUMN kind TEXT NOT NULL DEFAULT 'github';
      ALTER TABLE sites ADD COLUMN path TEXT NOT NULL DEFAULT '';
      ALTER TABLE sites ADD COLUMN dev_url TEXT NOT NULL DEFAULT '';
      -- A folder has no owner/repo, so that uniqueness no longer holds.
      DROP INDEX IF EXISTS sites_repo;
    `,
  },
  {
    // Sites are folders on this machine now. A row pointing at a GitHub
    // repository has no backend left to talk to, so it goes rather than
    // lingering as a site that renders an error.
    name: "006-local-only",
    sql: `
      DELETE FROM sites WHERE kind <> 'local';
      DROP INDEX IF EXISTS sites_repo;
      ALTER TABLE sites DROP COLUMN kind;
      ALTER TABLE sites DROP COLUMN owner;
      ALTER TABLE sites DROP COLUMN repo;
      ALTER TABLE sites DROP COLUMN branch;
      ALTER TABLE sites DROP COLUMN token;
      ALTER TABLE sites DROP COLUMN publish_mode;
      ALTER TABLE sites DROP COLUMN ai_titles;
      ALTER TABLE publishes DROP COLUMN pull_request_url;
    `,
  },
  {
    name: "007-pending-media",
    sql: `
      CREATE TABLE pending_media (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        data TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX pending_media_expiry ON pending_media (expires_at);
    `,
  },
  {
    // One row per file, bytes as a BLOB, so a thumbnail reads one image instead of the whole edit.
    name: "008-pending-media-files",
    sql: `
      DROP TABLE pending_media;
      CREATE TABLE pending_media (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX pending_media_expiry ON pending_media (expires_at);
      CREATE TABLE pending_media_files (
        media_id TEXT NOT NULL REFERENCES pending_media(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        path TEXT NOT NULL,
        src TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        content BLOB NOT NULL,
        PRIMARY KEY (media_id, position)
      );
    `,
  },
  {
    name: "009-push-after-publish",
    sql: `ALTER TABLE sites ADD COLUMN push_after_publish INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // People who edit, each signing in as themselves so a commit says who made it.
    name: "009-editors",
    sql: `
      CREATE TABLE editors (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE presence (
        site_id TEXT NOT NULL,
        path    TEXT NOT NULL,
        actor   TEXT NOT NULL,
        name    TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (site_id, path, actor)
      );
    `,
  },
  {
    // Publishes waiting for their moment, kept here because the editor may close the tab.
    name: "010-scheduled",
    sql: `
      CREATE TABLE scheduled (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        target     TEXT NOT NULL,
        label      TEXT NOT NULL,
        form       TEXT NOT NULL,
        due_at     INTEGER NOT NULL,
        actor      TEXT NOT NULL,
        author     TEXT,
        status     TEXT NOT NULL DEFAULT 'waiting',
        detail     TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX scheduled_due ON scheduled (status, due_at);
    `,
  },
  {
    name: "011-deploy-root",
    sql: "ALTER TABLE sites ADD COLUMN deploy_root TEXT NOT NULL DEFAULT '';",
  },
  {
    // A signed cookie stays valid until it expires; one signed out of is listed here until then.
    name: "012-revoked-sessions",
    sql: "CREATE TABLE revoked_sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);",
  },
  {
    // People who signed in with GitHub: who they are there, and nothing GitHub did not make public.
    name: "013-github-people",
    sql: `
      CREATE TABLE github_people (
        id      INTEGER PRIMARY KEY,
        login   TEXT NOT NULL,
        name    TEXT NOT NULL,
        salt    TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      );
    `,
  },
];

export interface GithubPerson {
  /** The account's id on GitHub, which never changes. */
  id: number;
  login: string;
  /** The name they show on GitHub, or their login when they show none. */
  name: string;
  /** Made when they first sign in; forgetting them ends every session that carries it. */
  salt: string;
}

export interface Submission {
  id: number;
  siteId: string;
  form: string;
  data: Record<string, string>;
  spamScore: number;
  spamReasons: string[];
  readAt: string | null;
  createdAt: string;
}

export interface Editor {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface Scheduled {
  id: number;
  siteId: string;
  /** `regions/<id>` or `collections/<name>/<slug>`: the editor path the form posts to. */
  target: string;
  label: string;
  /** The form exactly as submitted, replayed as a publish when it falls due. */
  form: Array<[string, string]>;
  dueAt: number;
  actor: string;
  author: { name: string; email: string } | null;
  status: "waiting" | "running" | "published" | "failed" | "cancelled";
  detail: string | null;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // Another process holding the file, such as a backup, is waited for rather than failing a publish.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)");
    const applied = new Set(
      (this.db.prepare("SELECT name FROM migrations").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) continue;
      // All of a migration or none of it: half a schema change fails every later start.
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO migrations (name) VALUES (?)").run(migration.name);
      });
    }
  }

  listSites(): Site[] {
    return (
      this.db
        .prepare("SELECT * FROM sites ORDER BY name COLLATE NOCASE")
        .all() as unknown as RawSite[]
    ).map(toSite);
  }

  getSite(id: string): Site | null {
    const row = this.db.prepare("SELECT * FROM sites WHERE id = ?").get(id) as unknown as
      | RawSite
      | undefined;
    return row ? toSite(row) : null;
  }

  addSite(site: NewSite): Site {
    this.db
      .prepare(
        "INSERT INTO sites (id, name, path, dev_url, push_after_publish, deploy_root) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        site.id,
        site.name,
        site.path,
        site.devUrl ?? "",
        site.pushAfterPublish ? 1 : 0,
        site.deployRoot ?? "",
      );
    const created = this.getSite(site.id);
    if (!created) throw new Error(`Site "${site.id}" vanished immediately after insert.`);
    return created;
  }

  /** Everything but the folder can change; the folder is what the site is. */
  updateSite(
    id: string,
    changes: { name: string; devUrl: string; pushAfterPublish: boolean; deployRoot?: string },
  ): void {
    this.db
      .prepare(
        "UPDATE sites SET name = ?, dev_url = ?, push_after_publish = ?, deploy_root = COALESCE(?, deploy_root) WHERE id = ?",
      )
      .run(
        changes.name,
        changes.devUrl,
        changes.pushAfterPublish ? 1 : 0,
        changes.deployRoot ?? null,
        id,
      );
  }

  removeSite(id: string): void {
    this.db.prepare("DELETE FROM sites WHERE id = ?").run(id);
  }

  pendingMedia(siteId: string, scope: string, id: string, now = Date.now()): UploadResult[] {
    this.requirePendingMedia(siteId, scope, id, now);
    const rows = this.db
      .prepare(
        "SELECT path, src, width, height, content FROM pending_media_files WHERE media_id = ? ORDER BY position",
      )
      .all(id) as unknown as PendingFileRow[];
    return rows.map(toUploadResult);
  }

  /** One pending file's bytes, for a thumbnail, without reading the rest of the edit. */
  pendingMediaFile(
    siteId: string,
    scope: string,
    id: string,
    position: number,
    now = Date.now(),
  ): { path: string; content: Uint8Array } | null {
    const row = this.db
      .prepare(
        `SELECT f.path, f.content FROM pending_media_files f
         JOIN pending_media m ON m.id = f.media_id
         WHERE m.id = ? AND m.site_id = ? AND m.scope = ? AND m.expires_at > ? AND f.position = ?`,
      )
      .get(id, siteId, scope, now, position) as { path: string; content: Uint8Array } | undefined;
    return row ?? null;
  }

  savePendingMedia(
    siteId: string,
    scope: string,
    files: UploadResult[],
    previous?: string,
    now = Date.now(),
  ): string {
    this.db.prepare("DELETE FROM pending_media WHERE expires_at <= ?").run(now);
    if (previous) this.requirePendingMedia(siteId, scope, previous, now);
    const bytes = files.reduce(
      (sum, file) => sum + file.base64.length + file.path.length + file.src.length,
      0,
    );
    const used = this.db
      .prepare("SELECT coalesce(sum(bytes), 0) AS bytes FROM pending_media WHERE id <> ?")
      .get(previous ?? "") as { bytes: number };
    if (bytes > 32 * 1024 * 1024 || used.bytes + bytes > 128 * 1024 * 1024)
      throw new UploadError(
        "Too many images are waiting to be published.",
        "Publish a smaller batch or try again after other pending edits are published.",
      );
    const id = previous ?? randomUUID();
    const insertFile = this.db.prepare(
      "INSERT INTO pending_media_files (media_id, position, path, src, width, height, content) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO pending_media (id, site_id, scope, bytes, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes, expires_at=excluded.expires_at",
        )
        .run(id, siteId, scope, bytes, now + 24 * 60 * 60 * 1000);
      this.db.prepare("DELETE FROM pending_media_files WHERE media_id = ?").run(id);
      files.forEach((file, position) => {
        insertFile.run(
          id,
          position,
          file.path,
          file.src,
          file.width ?? null,
          file.height ?? null,
          Buffer.from(file.base64, "base64"),
        );
      });
    });
    return id;
  }

  clearPendingMedia(siteId: string, scope: string, id: string): void {
    this.db
      .prepare("DELETE FROM pending_media WHERE id = ? AND site_id = ? AND scope = ?")
      .run(id, siteId, scope);
  }

  private requirePendingMedia(siteId: string, scope: string, id: string, now: number): void {
    const row = this.db
      .prepare(
        "SELECT 1 FROM pending_media WHERE id = ? AND site_id = ? AND scope = ? AND expires_at > ?",
      )
      .get(id, siteId, scope, now);
    if (!row)
      throw new UploadError(
        "The selected images are no longer available for this edit.",
        "Copy any unsaved text, reload the page, and select the images again.",
      );
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordPublish(entry: {
    siteId: string;
    regionId: string;
    commitSha: string;
    commitUrl: string;
    actor?: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO publishes (site_id, region_id, commit_sha, commit_url, actor) VALUES (?, ?, ?, ?, ?)",
      )
      .run(entry.siteId, entry.regionId, entry.commitSha, entry.commitUrl, entry.actor ?? null);
  }

  addSubmission(entry: {
    siteId: string;
    form: string;
    data: Record<string, string>;
    spamScore: number;
    spamReasons: string[];
  }): number {
    const result = this.db
      .prepare(
        "INSERT INTO submissions (site_id, form, data, spam_score, spam_reasons) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        entry.siteId,
        entry.form,
        JSON.stringify(entry.data),
        entry.spamScore,
        JSON.stringify(entry.spamReasons),
      );
    return Number(result.lastInsertRowid);
  }

  /** Submissions across every site, newest first: the unified inbox. */
  listSubmissions(
    options: {
      siteId?: string;
      /** The only sites to list from, for someone who cannot open them all. */
      among?: string[];
      includeSpam?: boolean;
      limit?: number;
    } = {},
  ): Submission[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.siteId) {
      clauses.push("site_id = ?");
      params.push(options.siteId);
    }
    if (options.among) {
      clauses.push(`site_id IN (${options.among.map(() => "?").join(",") || "NULL"})`);
      params.push(...options.among);
    }
    if (!options.includeSpam) clauses.push("spam_score < 3");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(options.limit ?? 200);

    return (
      this.db
        .prepare(`SELECT * FROM submissions ${where} ORDER BY id DESC LIMIT ?`)
        .all(...params) as unknown as RawSubmission[]
    ).map(toSubmission);
  }

  getSubmission(id: number): Submission | null {
    const row = this.db.prepare("SELECT * FROM submissions WHERE id = ?").get(id) as unknown as
      | RawSubmission
      | undefined;
    return row ? toSubmission(row) : null;
  }

  countUnread(among?: string[]): number {
    const within = among
      ? ` AND site_id IN (${among.map(() => "?").join(",") || "NULL"})`
      : "";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM submissions WHERE read_at IS NULL AND spam_score < 3${within}`,
      )
      .get(...(among ?? [])) as unknown as { n: number };
    return row.n;
  }

  markRead(id: number, read = true): void {
    this.db
      .prepare("UPDATE submissions SET read_at = ? WHERE id = ?")
      .run(read ? new Date().toISOString() : null, id);
  }

  deleteSubmission(id: number): void {
    this.db.prepare("DELETE FROM submissions WHERE id = ?").run(id);
  }

  listEditors(): Editor[] {
    return (
      this.db
        .prepare("SELECT * FROM editors ORDER BY name COLLATE NOCASE")
        .all() as unknown as RawEditor[]
    ).map(toEditor);
  }

  getEditor(id: number): Editor | null {
    const row = this.db.prepare("SELECT * FROM editors WHERE id = ?").get(id) as unknown as
      | RawEditor
      | undefined;
    return row ? toEditor(row) : null;
  }

  findEditor(email: string): Editor | null {
    const row = this.db.prepare("SELECT * FROM editors WHERE email = ?").get(email.trim()) as
      | RawEditor
      | undefined;
    return row ? toEditor(row) : null;
  }

  addEditor(editor: { name: string; email: string; passwordHash: string }): Editor {
    const result = this.db
      .prepare("INSERT INTO editors (name, email, password_hash) VALUES (?, ?, ?)")
      .run(editor.name.trim(), editor.email.trim(), editor.passwordHash);
    return this.getEditor(Number(result.lastInsertRowid)) as Editor;
  }

  setEditorPassword(id: number, passwordHash: string): void {
    this.db.prepare("UPDATE editors SET password_hash = ? WHERE id = ?").run(passwordHash, id);
  }

  removeEditor(id: number): void {
    this.db.prepare("DELETE FROM editors WHERE id = ?").run(id);
  }

  /** Records a GitHub sign-in, and forgets people whose last session has long run out. */
  saveGithubPerson(
    person: { id: number; login: string; name: string },
    now = Date.now(),
  ): GithubPerson {
    this.db.prepare("DELETE FROM github_people WHERE seen_at < ?").run(now - 30 * 86_400_000);
    this.db
      .prepare(
        "INSERT INTO github_people (id, login, name, salt, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET login = excluded.login, name = excluded.name, seen_at = excluded.seen_at",
      )
      .run(person.id, person.login, person.name, randomBytes(12).toString("base64url"), now);
    return this.getGithubPerson(person.id) as GithubPerson;
  }

  getGithubPerson(id: number): GithubPerson | null {
    const row = this.db
      .prepare("SELECT id, login, name, salt FROM github_people WHERE id = ?")
      .get(id) as unknown as GithubPerson | undefined;
    return row ? { id: Number(row.id), login: row.login, name: row.name, salt: row.salt } : null;
  }

  /** Signs everyone who came in through GitHub out, wherever they are. */
  clearGithubPeople(): void {
    this.db.exec("DELETE FROM github_people");
  }

  /** Marks `actor` as having this content open, and returns who else did recently. */
  presence(
    entry: { siteId: string; path: string; actor: string; name: string },
    withinMs = 10 * 60_000,
    now = Date.now(),
  ): Array<{ name: string; seenAt: number }> {
    this.db
      .prepare(
        "INSERT INTO presence (site_id, path, actor, name, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (site_id, path, actor) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at",
      )
      .run(entry.siteId, entry.path, entry.actor, entry.name, now);
    this.db.prepare("DELETE FROM presence WHERE seen_at < ?").run(now - withinMs);
    return (
      this.db
        .prepare(
          "SELECT name, seen_at AS seenAt FROM presence WHERE site_id = ? AND path = ? AND actor != ? ORDER BY seen_at DESC",
        )
        .all(entry.siteId, entry.path, entry.actor) as unknown as Array<{
        name: string;
        seenAt: number;
      }>
    ).map((row) => ({ name: row.name, seenAt: Number(row.seenAt) }));
  }

  schedule(entry: Omit<Scheduled, "id" | "status" | "detail">): Scheduled {
    const result = this.db
      .prepare(
        "INSERT INTO scheduled (site_id, target, label, form, due_at, actor, author) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.siteId,
        entry.target,
        entry.label,
        JSON.stringify(entry.form),
        entry.dueAt,
        entry.actor,
        entry.author ? JSON.stringify(entry.author) : null,
      );
    return this.getScheduled(Number(result.lastInsertRowid)) as Scheduled;
  }

  getScheduled(id: number): Scheduled | null {
    const row = this.db.prepare("SELECT * FROM scheduled WHERE id = ?").get(id) as unknown as
      | RawScheduled
      | undefined;
    return row ? toScheduled(row) : null;
  }

  listScheduled(siteId: string): Scheduled[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM scheduled WHERE site_id = ? AND (status = 'waiting' OR created_at > datetime('now', '-7 days')) ORDER BY due_at",
        )
        .all(siteId) as unknown as RawScheduled[]
    ).map(toScheduled);
  }

  dueScheduled(now = Date.now()): Scheduled[] {
    return (
      this.db
        .prepare("SELECT * FROM scheduled WHERE status = 'waiting' AND due_at <= ? ORDER BY due_at")
        .all(now) as unknown as RawScheduled[]
    ).map(toScheduled);
  }

  /** Takes a due publish for running; false when another run already took it. */
  claimScheduled(id: number): boolean {
    return (
      Number(
        this.db
          .prepare("UPDATE scheduled SET status = 'running' WHERE id = ? AND status = 'waiting'")
          .run(id).changes,
      ) === 1
    );
  }

  /**
   * Puts back publishes a stopped studio had taken but not finished, so they are tried again.
   * One that did land is then refused as already changed, never published twice.
   */
  recoverScheduled(): number {
    return Number(
      this.db.prepare("UPDATE scheduled SET status = 'waiting' WHERE status = 'running'").run()
        .changes,
    );
  }

  settleScheduled(id: number, status: Scheduled["status"], detail?: string): void {
    this.db
      .prepare(
        "UPDATE scheduled SET status = ?, detail = ? WHERE id = ? AND status IN ('waiting', 'running')",
      )
      .run(status, detail ?? null, id);
  }

  /** Submissions older than `days` are deleted: an inbox is not an archive. */
  /** Retires one signed session for the rest of its life, and forgets those that have expired. */
  revokeSession(id: string, expiresAt: number, now = Date.now()): void {
    this.db.prepare("DELETE FROM revoked_sessions WHERE expires_at < ?").run(now);
    this.db
      .prepare("INSERT OR IGNORE INTO revoked_sessions (id, expires_at) VALUES (?, ?)")
      .run(id, expiresAt);
  }

  isSessionRevoked(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM revoked_sessions WHERE id = ?").get(id) !== undefined;
  }

  pruneSubmissions(days: number): number {
    return Number(
      this.db
        .prepare("DELETE FROM submissions WHERE created_at < datetime('now', ?)")
        .run(`-${Math.floor(days)} days`).changes,
    );
  }

  close(): void {
    if (!this.db.isOpen) return;
    this.db.close();
  }
}

interface RawSubmission {
  id: number;
  site_id: string;
  form: string;
  data: string;
  spam_score: number;
  spam_reasons: string;
  read_at: string | null;
  created_at: string;
}

function toSubmission(row: RawSubmission): Submission {
  return {
    id: row.id,
    siteId: row.site_id,
    form: row.form,
    data: safeParse(row.data, {}),
    spamScore: row.spam_score,
    spamReasons: safeParse(row.spam_reasons, []),
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/** A row that somehow holds invalid JSON should not take the inbox down. */
function safeParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface RawSite {
  id: string;
  name: string;
  path: string;
  dev_url: string;
  push_after_publish: number;
  deploy_root: string | null;
  created_at: string;
}

function toSite(row: RawSite): Site {
  return {
    id: row.id,
    name: row.name,
    path: row.path ?? "",
    devUrl: row.dev_url ?? "",
    pushAfterPublish: row.push_after_publish === 1,
    deployRoot: row.deploy_root ?? "",
    createdAt: row.created_at,
  };
}

interface PendingFileRow {
  path: string;
  src: string;
  width: number | null;
  height: number | null;
  content: Uint8Array;
}

function toUploadResult(row: PendingFileRow): UploadResult {
  return {
    path: row.path,
    src: row.src,
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    base64: Buffer.from(row.content).toString("base64"),
  };
}

interface RawEditor {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  created_at: string;
}

function toEditor(row: RawEditor): Editor {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

interface RawScheduled {
  id: number;
  site_id: string;
  target: string;
  label: string;
  form: string;
  due_at: number;
  actor: string;
  author: string | null;
  status: Scheduled["status"];
  detail: string | null;
}

function toScheduled(row: RawScheduled): Scheduled {
  return {
    id: Number(row.id),
    siteId: row.site_id,
    target: row.target,
    label: row.label,
    form: JSON.parse(row.form),
    dueAt: Number(row.due_at),
    actor: row.actor,
    author: row.author ? JSON.parse(row.author) : null,
    status: row.status,
    detail: row.detail,
  };
}
