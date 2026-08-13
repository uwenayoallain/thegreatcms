/**
 * Storage. `node:sqlite` ships with Node, so the studio has no native module to
 * compile, no database server to run, and no ORM in the request path — one file
 * on disk is the whole persistence story for however many sites you manage.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Site {
  id: string;
  name: string;
  owner: string;
  repo: string;
  branch: string;
  /** Token with `contents: write` on this repository. */
  token: string;
  createdAt: string;
}

export type NewSite = Omit<Site, "createdAt">;

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
];

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

export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
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
      this.db.exec(migration.sql);
      this.db.prepare("INSERT INTO migrations (name) VALUES (?)").run(migration.name);
    }
  }

  listSites(): Site[] {
    return (
      this.db.prepare("SELECT * FROM sites ORDER BY name COLLATE NOCASE").all() as RawSite[]
    ).map(toSite);
  }

  getSite(id: string): Site | null {
    const row = this.db.prepare("SELECT * FROM sites WHERE id = ?").get(id) as RawSite | undefined;
    return row ? toSite(row) : null;
  }

  addSite(site: NewSite): Site {
    this.db
      .prepare("INSERT INTO sites (id, name, owner, repo, branch, token) VALUES (?, ?, ?, ?, ?, ?)")
      .run(site.id, site.name, site.owner, site.repo, site.branch, site.token);
    const created = this.getSite(site.id);
    if (!created) throw new Error(`Site "${site.id}" vanished immediately after insert.`);
    return created;
  }

  removeSite(id: string): void {
    this.db.prepare("DELETE FROM sites WHERE id = ?").run(id);
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

  recentPublishes(siteId: string, limit = 10): Publish[] {
    return this.db
      .prepare(
        "SELECT region_id, commit_sha, commit_url, actor, created_at FROM publishes WHERE site_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(siteId, limit) as Publish[];
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

  /** Submissions across every site, newest first — the unified inbox. */
  listSubmissions(
    options: { siteId?: string; includeSpam?: boolean; limit?: number } = {},
  ): Submission[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.siteId) {
      clauses.push("site_id = ?");
      params.push(options.siteId);
    }
    if (!options.includeSpam) clauses.push("spam_score < 3");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(options.limit ?? 200);

    return (
      this.db
        .prepare(`SELECT * FROM submissions ${where} ORDER BY id DESC LIMIT ?`)
        .all(...params) as RawSubmission[]
    ).map(toSubmission);
  }

  getSubmission(id: number): Submission | null {
    const row = this.db.prepare("SELECT * FROM submissions WHERE id = ?").get(id) as
      | RawSubmission
      | undefined;
    return row ? toSubmission(row) : null;
  }

  countUnread(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM submissions WHERE read_at IS NULL AND spam_score < 3")
      .get() as { n: number };
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

  close(): void {
    this.db.close();
  }
}

export interface Publish {
  region_id: string;
  commit_sha: string;
  commit_url: string;
  actor: string | null;
  created_at: string;
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
  owner: string;
  repo: string;
  branch: string;
  token: string;
  created_at: string;
}

function toSite(row: RawSite): Site {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    token: row.token,
    createdAt: row.created_at,
  };
}
