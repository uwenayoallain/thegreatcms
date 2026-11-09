/** Whether a site's dev server is answering, so a screen can say so instead of framing an error page. */

import { connect } from "node:net";
import type { Site } from "./db.js";
import { isHttpUrl } from "./http.js";

/** A server on the same machine or network answers in milliseconds; this is the limit, not the norm. */
const TIMEOUT_MS = 1200;
const FRESH_MS = { up: 15_000, down: 4_000 };

export class Liveness {
  private readonly seen = new Map<string, { up: boolean; at: number }>();
  private readonly asking = new Map<string, Promise<boolean>>();

  /**
   * `probeUrls` maps a site id to where this server reaches its dev server, when that is not where
   * browsers do: a studio in a container reaches `http://previews:4321`, a browser
   * `https://paraline-preview.example.com`.
   */
  constructor(
    private readonly probeUrls: ReadonlyMap<string, string> = new Map(),
    /** The preview service, for the sites it runs: it answers for them whatever a probe URL says. */
    private readonly managed: (site: Site) => string | undefined = () => undefined,
    /** Called when one site's screen asks, so its dev server can start before anyone looks. */
    private readonly opened: (site: Site) => void = () => {},
  ) {}

  /** `null` when the site has no dev server to ask about. Asked by a screen about this one site. */
  running(site: Site): Promise<boolean | null> {
    this.opened(site);
    return this.check(site);
  }

  private async check(site: Site): Promise<boolean | null> {
    const url = this.managed(site) || this.probeUrls.get(site.id) || site.devUrl;
    if (!url) return null;
    const known = this.seen.get(url);
    if (known && Date.now() - known.at < (known.up ? FRESH_MS.up : FRESH_MS.down)) return known.up;
    let pending = this.asking.get(url);
    if (!pending) {
      pending = ask(url).finally(() => this.asking.delete(url));
      this.asking.set(url, pending);
    }
    const up = await pending;
    this.seen.set(url, { up, at: Date.now() });
    return up;
  }

  /** Every site at once, for the screens that list them. */
  async all(sites: Site[]): Promise<Map<string, boolean | null>> {
    // The list starts no dev servers: only opening a site does.
    const answers = await Promise.all(sites.map((site) => this.check(site)));
    return new Map(sites.map((site, index) => [site.id, answers[index] ?? null]));
  }
}

/**
 * Whether anything accepts a connection there. A request would make a dev server compile a page,
 * which can take longer than anyone should wait for a status dot; a connection cannot.
 */
function ask(url: string): Promise<boolean> {
  // Only a web server is asked; a file:, data: or any other URL is not somewhere to connect.
  if (!isHttpUrl(url)) return Promise.resolve(false);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const host = target.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: TIMEOUT_MS });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
