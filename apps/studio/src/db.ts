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
];

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
