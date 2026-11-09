/** Local mode: the studio on loopback for the person who started it, signed in by a one-time link. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionCookie, readSession } from "./auth.js";

export const LOCAL_SIGN_IN = "/local/sign-in";

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

/** The session secret, kept beside the database so a restart does not sign the browser out. */
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

export function oneTimeToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface LocalGuardOptions {
  port: number;
  /** How the studio's own URL spells its host: `127.0.0.1` or `[::1]`. */
  urlHost: string;
  token: string;
  /** What the app signs sessions with: `sessionKey(secret, password)`. */
  signingKey: string;
  /** Where a fresh sign-in lands. */
  landing: string;
  /** Told when a link that was already used is presented by someone without a session. */
  onRefused?: () => void;
}

const page = (title: string, body: string, status: number) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );

const sameToken = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/**
 * Wraps the app for local mode. A request must name this machine and this port in `Host`, which is
 * what stops a web page reaching the studio through a hostname it controls (DNS rebinding); the
 * link from the terminal signs a browser in once; and the password form is not offered at all.
 */
export function localGuard(app: Fetch, options: LocalGuardOptions): Fetch {
  const canonical = `${options.urlHost}:${options.port}`;
  const aliases = new Set(
    ["127.0.0.1", "localhost", "[::1]"].map((host) => `${host}:${options.port}`),
  );
  let used = false;

  return (request, ...rest) => {
    const host = (request.headers.get("host") ?? "").toLowerCase();
    if (host !== canonical) {
      if (!aliases.has(host)) {
        return new Response(`This studio only answers at http://${canonical}.\n`, {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      const url = new URL(request.url);
      // One spelling of the address, so the session cookie has one home; nothing but a page load follows.
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(`Use http://${canonical}.\n`, { status: 403 });
      }
      return new Response(null, {
        status: 307,
        headers: { location: `http://${canonical}${url.pathname}${url.search}` },
      });
    }

    const url = new URL(request.url);
    if (url.pathname === LOCAL_SIGN_IN) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const supplied = url.searchParams.get("token") ?? "";
      if (!used && sameToken(supplied, options.token)) {
        used = true;
        return new Response(null, {
          status: 303,
          headers: {
            location: options.landing,
            "set-cookie": createSessionCookie(options.signingKey),
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      }
      // The link reopened from history by the browser it signed in: nothing to refuse.
      if (readSession(request.headers.get("cookie") ?? undefined, options.signingKey)) {
        return new Response(null, { status: 303, headers: { location: options.landing } });
      }
      if (used && sameToken(supplied, options.token)) options.onRefused?.();
      return page(
        "This sign-in link no longer works",
        "Each link signs one browser in, once. Stop <code>greatcms studio</code> in the terminal and run it again for a new one.",
        403,
      );
    }
    if (url.pathname === "/sign-in") {
      return page(
        "Open the link from the terminal",
        "This studio runs on your machine and has no password. <code>greatcms studio</code> printed a one-time sign-in link when it started: open that, or run the command again for a new one.",
        request.method === "GET" ? 401 : 403,
      );
    }
    return app(request, ...rest);
  };
}
