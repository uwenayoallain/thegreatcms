/** Which sites someone who signed in with GitHub may open: those GitHub lets them push to. */

import { originOf } from "./connect.js";
import type { Site } from "./db.js";
import type { GitHub } from "./github.js";

/** How long GitHub's answer is believed before it is asked again. */
const BELIEVED_MS = 90_000;
const MAX_ANSWERS = 5000;

export interface Person {
  id: number;
  login: string;
}

export class SiteAccess {
  private readonly answers = new Map<string, { allowed: Promise<boolean>; until: number }>();
  private readonly origins = new Map<string, { origin: Promise<string | null>; until: number }>();

  constructor(
    private readonly github: GitHub,
    private readonly origin: (path: string) => Promise<string | null> = originOf,
  ) {}

  /**
   * Whether the person may open the site. `fresh` asks GitHub now rather than trusting an answer
   * from the last minute or so, which is what a publish does. GitHub not answering means no.
   */
  async reaches(person: Person, site: Site, fresh = false, now = Date.now()): Promise<boolean> {
    const origin = await this.originOf(site.path, now);
    if (!origin || !this.github.repositoryOf(origin)) return false;
    const key = `${person.id}\n${site.path}`;
    const known = this.answers.get(key);
    if (!fresh && known && known.until > now) return known.allowed;
    const allowed = this.github.canPush(origin, person).catch(() => false);
    if (this.answers.size >= MAX_ANSWERS) this.answers.clear();
    this.answers.set(key, { allowed, until: now + BELIEVED_MS });
    return allowed;
  }

  /** The sites among these the person may open. */
  async among(person: Person, sites: Site[]): Promise<Site[]> {
    const allowed = await Promise.all(sites.map((site) => this.reaches(person, site)));
    return sites.filter((_, index) => allowed[index]);
  }

  /** Drops every answer, after GitHub was connected, disconnected or changed. */
  forget(): void {
    this.answers.clear();
    this.origins.clear();
  }

  private originOf(path: string, now: number): Promise<string | null> {
    const known = this.origins.get(path);
    if (known && known.until > now) return known.origin;
    const origin = this.origin(path);
    this.origins.set(path, { origin, until: now + BELIEVED_MS });
    return origin;
  }
}
