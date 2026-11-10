/**
 * Walks a dev server's pages and the modules they load before anyone sees them. A dev server
 * prepares dependencies the first time a browser asks for them, and until it has, it answers 504
 * and reloads the page: asked for here first, that happens with nobody watching.
 */

import { request } from "node:http";

/**
 * A GET to a dev server on this machine, shaped like `fetch`. The built-in fetch refuses a list of
 * port numbers it calls unsafe, and a dev server may be given any port.
 */
export const localFetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const asked = request(
      String(input),
      {
        method: "GET",
        headers: init?.headers as Record<string, string>,
        signal: init?.signal ?? undefined,
      },
      (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("error", reject);
        answer.on("end", () => {
          const status = answer.statusCode ?? 502;
          const headers = new Headers();
          for (const [name, value] of Object.entries(answer.headers)) {
            if (typeof value === "string") headers.set(name, value);
          }
          // A Response may not carry a body on these, nor a status below 200.
          const bare = status < 200 || status === 204 || status === 205 || status === 304;
          resolve(
            new Response(bare ? null : Buffer.concat(chunks), {
              status: status < 200 ? 502 : status,
              headers,
            }),
          );
        });
      },
    );
    asked.on("error", reject);
    asked.end();
  });

export interface WarmOptions {
  /** The most this may take; whatever is left unwalked is prepared on demand, as before. */
  budgetMs?: number;
  maxModules?: number;
  /** Pages walked besides the first, found by following its links. */
  maxPages?: number;
  /** How often the walk starts over after the dev server said its dependencies changed. */
  rounds?: number;
  fetcher?: typeof fetch;
  pause?: (ms: number) => Promise<void>;
}

export interface Warmed {
  modules: number;
  pages: number;
  rounds: number;
  /** False when the budget ran out, or the dev server never stopped preparing. */
  settled: boolean;
}

const MODULE_IN_HTML =
  /(?:src|component-url|renderer-url|before-hydration-url)="(\/[^"]+)"|<link[^>]+rel="modulepreload"[^>]+href="(\/[^"]+)"/g;
const LINK_IN_HTML = /<a\s[^>]*href="(\/[^"#?]*)"/g;
const IMPORT_IN_SCRIPT = /(?:\bfrom|\bimport)\s*\(?\s*["'](\/[^"']+)["']/g;

/** A path on this server and nowhere else: `//host` and `/\host` are other servers. */
function local(path: string): string | null {
  const decoded = path.replaceAll("&amp;", "&");
  return /^\/(?![/\\])/.test(decoded) ? decoded : null;
}

function found(pattern: RegExp, text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const path = local(match[1] ?? match[2] ?? "");
    if (path) paths.push(path);
  }
  return paths;
}

export async function warmModules(origin: string, options: WarmOptions = {}): Promise<Warmed> {
  const {
    budgetMs = 25_000,
    maxModules = 600,
    maxPages = 8,
    rounds = 5,
    fetcher = localFetch,
    pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;
  const deadline = Date.now() + budgetMs;
  let modules = 0;
  let pages = 0;
  for (let round = 1; round <= rounds; round++) {
    const seen = new Set<string>(["/"]);
    const queue: Array<{ path: string; page: boolean }> = [{ path: "/", page: true }];
    let changed = false;
    // Set when the clock, not the site, ended the walk: what was not reached is not prepared.
    let cut = false;
    modules = 0;
    pages = 0;
    const walk = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (Date.now() >= deadline) {
          cut = true;
          return;
        }
        const { path, page } = next;
        let type = "";
        let body = "";
        try {
          const patience = Math.max(1, Math.min(15_000, deadline - Date.now()));
          let clock: NodeJS.Timeout | undefined;
          // Raced against a clock of its own: a server that never answers cannot hold the walk.
          // oxlint-disable-next-line no-await-in-loop -- a few walkers, each taking the next in line
          const answer = await Promise.race([
            fetcher(`${origin}${path}`, {
              headers: { accept: page ? "text/html" : "*/*" },
              redirect: "manual",
              signal: AbortSignal.timeout(patience),
            }),
            new Promise<never>((_, reject) => {
              clock = setTimeout(() => {
                cut = true;
                reject(new Error("too slow"));
              }, patience);
            }),
          ]).finally(() => clearTimeout(clock));
          // Vite's answer for a dependency it has since prepared again.
          if (answer.status === 504) changed = true;
          type = answer.headers.get("content-type") ?? "";
          // oxlint-disable-next-line no-await-in-loop -- see above
          body = answer.ok ? await answer.text() : "";
        } catch {
          continue;
        }
        const add = (paths: string[], asPage: boolean) => {
          for (const one of paths) {
            if (seen.has(one) || seen.size >= maxModules) continue;
            if (asPage && pages >= maxPages) continue;
            seen.add(one);
            if (asPage) pages++;
            queue.push({ path: one, page: asPage });
          }
        };
        if (type.includes("text/html")) {
          if (page) add(found(LINK_IN_HTML, body), true);
          add(found(MODULE_IN_HTML, body), false);
        } else if (/javascript|typescript/.test(type)) {
          modules++;
          add(found(IMPORT_IN_SCRIPT, body), false);
        }
      }
    };
    // oxlint-disable-next-line no-await-in-loop -- each round starts from what the last one changed
    await Promise.all(Array.from({ length: 6 }, walk));
    const settled = !changed && !cut;
    if (settled || cut || round === rounds) {
      return { modules, pages: pages + 1, rounds: round, settled };
    }
    // oxlint-disable-next-line no-await-in-loop -- the dev server needs a moment to finish preparing
    await pause(400);
  }
  return { modules, pages: pages + 1, rounds, settled: false };
}
