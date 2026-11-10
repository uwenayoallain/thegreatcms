/** Local mode: the studio on loopback, where whoever can reach it is the owner and nobody signs in. */

import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionCookie } from "./auth.js";

type Fetch = (request: Request, ...rest: unknown[]) => Response | Promise<Response>;

/** Whether a `--host` value can only be reached from this machine. */
export function isLoopback(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "::1" || /^127(\.\d{1,3}){3}$/.test(name);
}

/** The address to listen on, and how a URL spells it. */
export function loopbackAddress(host: string): { bind: string; urlHost: string } {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "::1") return { bind: "::1", urlHost: "[::1]" };
  return name === "localhost"
    ? { bind: "127.0.0.1", urlHost: "127.0.0.1" }
    : { bind: name, urlHost: name };
}

/** The signing secret, kept beside the database so notices and preview links outlive a restart. */
export function localSecret(stateDir: string): string {
  const file = join(stateDir, "secret");
  try {
    const saved = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(saved)) return saved;
  } catch {
    // First run in this folder.
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

/** A password nobody is told: local mode has no password form, and the app still needs one to sign with. */
export function localPassword(secret: string): string {
  return createHmac("sha256", secret).update("greatcms local password").digest("hex");
}

export interface LocalGuardOptions {
  port: number;
  /** How the studio's own URL spells its host: `127.0.0.1` or `[::1]`. */
  urlHost: string;
  /** What the app signs sessions with: `sessionKey(secret, password)`. */
  signingKey: string;
  /** The site's own page, where the sign-in addresses lead. */
  landing: string;
}

/** Addresses for signing in or out, which nobody does here: they lead to the site. */
const NOTHING_TO_DO = new Set(["/sign-in", "/local/sign-in", "/sign-out"]);

const refused = (message: string) =>
  new Response(`${message}\n`, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * Wraps the app for local mode. A request must name this machine and this port in `Host`, which is
 * what stops a web page reaching the studio through a hostname it controls (DNS rebinding), and
 * anything but a page load must come from the studio's own pages. What passes is the owner: the app
 * is handed a session signed with its own key, so its sign-in code is the same as on a server.
 */
export function localGuard(app: Fetch, options: LocalGuardOptions): Fetch {
  const canonical = `${options.urlHost}:${options.port}`;
  const aliases = new Set(
    ["127.0.0.1", "localhost", "[::1]"].map((host) => `${host}:${options.port}`),
  );

  return (request, ...rest) => {
    const host = (request.headers.get("host") ?? "").toLowerCase();
    const url = new URL(request.url);
    const reads = request.method === "GET" || request.method === "HEAD";
    if (host !== canonical) {
      if (!aliases.has(host)) return refused(`This studio only answers at http://${canonical}.`);
      // One spelling of the address, so the studio has one origin; nothing but a page load follows.
      if (!reads) return refused(`Use http://${canonical}.`);
      return new Response(null, {
        status: 307,
        headers: { location: `http://${canonical}${url.pathname}${url.search}` },
      });
    }

    // A site's own forms post here from the site's address: public, and never the owner's doing.
    if (url.pathname.startsWith("/f/")) return app(request, ...rest);

    if (!reads) {
      // No cookie stands between a web page and the owner here, so the browser must vouch for the sender.
      const origin = request.headers.get("origin");
      const site = request.headers.get("sec-fetch-site");
      const own = origin
        ? origin === `http://${canonical}` && (!site || site === "same-origin")
        : site === "same-origin";
      if (!own) return refused("Only the studio's own pages can change anything here.");
    }

    if (NOTHING_TO_DO.has(url.pathname)) {
      return new Response(null, {
        status: 303,
        headers: { location: options.landing, "cache-control": "no-store" },
      });
    }

    const [session = ""] = createSessionCookie(options.signingKey).split(";");
    const name = session.slice(0, session.indexOf("="));
    // Whatever session the browser sent is dropped: the only one the app sees is this one.
    const others = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && part.split("=")[0] !== name);
    request.headers.set("cookie", [...others, session].join("; "));
    return app(request, ...rest);
  };
}
