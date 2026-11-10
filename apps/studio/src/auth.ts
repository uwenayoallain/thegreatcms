/** Authentication: the owner's password from the environment, editors' passwords hashed, one signed cookie. */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const COOKIE = "greatcms_session";
const PREVIEW_COOKIE = "greatcms_preview";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

export interface Session {
  /** `studio` for the owner, `editor:<id>` for an editor, `github:<id>` for a GitHub account. */
  actor: string;
  /** For an editor, a fingerprint of their password hash: changing the password ends the session. */
  stamp: string;
  expiresAt: number;
  /** The token's signature: unique to this sign-in, so signing out can retire exactly it. */
  id: string;
}

export interface CookieOptions {
  actor?: string;
  stamp?: string;
  /** Set over HTTPS, so the cookie never rides a plaintext request. */
  secure?: boolean;
}

/**
 * The studio's own session. Host-only on purpose: the preview runs the site's code, and a
 * cookie scoped to the parent domain would hand that code the studio.
 */
export function createSessionCookie(secret: string, options: CookieOptions = {}): string {
  return signedCookie(COOKIE, keyFor(secret, "session"), options);
}

/** Opens the preview for whoever signed in, via the proxy's forward-auth, and nothing else. */
export function createPreviewCookie(
  secret: string,
  options: CookieOptions & { domain?: string },
): string {
  return signedCookie(PREVIEW_COOKIE, keyFor(secret, "preview"), options, options.domain);
}

function signedCookie(
  name: string,
  key: string,
  { actor = "studio", stamp = "-", secure = false }: CookieOptions,
  domain?: string,
): string {
  const expiresAt = Date.now() + MAX_AGE_SECONDS * 1000;
  const payload = `${actor}.${stamp}.${expiresAt}`;
  const value = `${payload}.${sign(payload, key)}`;
  // Lax rather than Strict: every state change is a same-origin POST, checked separately.
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${cookieScope(secure, domain)}`;
}

/** A short fingerprint of an editor's password hash, signed so it says nothing about the hash. */
export function editorStamp(secret: string, passwordHash: string): string {
  return sign(passwordHash, keyFor(secret, "stamp")).slice(0, 16);
}

const SHARE_COOKIE = "greatcms_share";
const SHARE_DAYS = 7;

/**
 * A preview link for someone without an account: the site it is for, when it stops working, and
 * a signature. It opens the preview and nothing else; the studio never reads it as a session.
 */
export function createShareToken(secret: string, siteId: string, now = Date.now()): string {
  const payload = `${siteId}.${now + SHARE_DAYS * 86_400_000}`;
  return `${payload}.${sign(payload, keyFor(secret, "share"))}`;
}

/** The site a share token is for, or null when it is forged or has run out. */
export function readShareToken(token: string | undefined, secret: string): string | null {
  const parts = decoded(token)?.split(".");
  if (parts?.length !== 3) return null;
  const [siteId, expiry, signature] = parts as [string, string, string];
  if (!constantTimeEqual(sign(`${siteId}.${expiry}`, keyFor(secret, "share")), signature))
    return null;
  if (!(Number(expiry) > Date.now())) return null;
  return siteId;
}

export function shareCookie(token: string, secure = false, domain?: string): string {
  return `${SHARE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SHARE_DAYS * 86_400}${cookieScope(secure, domain)}`;
}

export function readShareCookie(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[SHARE_COOKIE];
}

const GITHUB_COOKIE = "greatcms_github";
const GITHUB_MINUTES = 10;

/** One trip to GitHub and back: what the callback must be handed, and where to go afterwards. */
export interface GithubTrip {
  /** Sent to GitHub and expected back unchanged. */
  state: string;
  /** PKCE: its hash goes out with the browser, the verifier itself only from server to GitHub. */
  verifier: string;
  challenge: string;
  next: string;
  /** Names this trip, so it can be marked as used. */
  id: string;
  expiresAt: number;
}

function githubTrip(key: string, nonce: string, next: string, expiresAt: number): GithubTrip {
  const verifier = sign(`verifier ${nonce}`, key);
  return {
    state: sign(`state ${nonce}`, key),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    next,
    id: `github-trip:${sign(`id ${nonce}`, key)}`,
    expiresAt,
  };
}

/**
 * Starts a sign-in with GitHub: a cookie that ties the answer to this browser for ten minutes.
 * Only the callback path sees it, and the state GitHub carries cannot be worked out without it.
 */
export function startGithubTrip(
  secret: string,
  next: string,
  secure = false,
  now = Date.now(),
): { cookie: string; trip: GithubTrip } {
  const key = keyFor(secret, "github");
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = now + GITHUB_MINUTES * 60_000;
  const payload = `${nonce}.${expiresAt}.${Buffer.from(next).toString("base64url")}`;
  return {
    cookie: `${GITHUB_COOKIE}=${payload}.${sign(payload, key)}; Path=/sign-in/github; HttpOnly; SameSite=Lax; Max-Age=${GITHUB_MINUTES * 60}${cookieScope(secure)}`,
    trip: githubTrip(key, nonce, next, expiresAt),
  };
}

/** The trip this browser began, or null when its cookie is missing, forged or has run out. */
export function readGithubTrip(
  cookieHeader: string | undefined,
  secret: string,
  now = Date.now(),
): GithubTrip | null {
  const parts = parseCookies(cookieHeader)[GITHUB_COOKIE]?.split(".");
  if (parts?.length !== 4) return null;
  const [nonce, expiry, next, signature] = parts as [string, string, string, string];
  const key = keyFor(secret, "github");
  if (!constantTimeEqual(sign(`${nonce}.${expiry}.${next}`, key), signature)) return null;
  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
  return githubTrip(key, nonce, Buffer.from(next, "base64url").toString(), expiresAt);
}

export function clearGithubTrip(secure = false): string {
  return `${GITHUB_COOKIE}=; Path=/sign-in/github; HttpOnly; SameSite=Lax; Max-Age=0${cookieScope(secure)}`;
}

const FLASH_COOKIE = "greatcms_flash";
const FLASH_SECONDS = 60;

/** What an action answers with once the browser has followed its redirect. */
export interface Flash {
  kind: "success" | "error";
  message: string;
}

/** A notice for the next page this person opens: signed, theirs alone, and gone in a minute. */
export function flashCookie(
  secret: string,
  actor: string,
  flash: Flash,
  secure = false,
  now = Date.now(),
): string {
  const text = Buffer.from(flash.message.slice(0, 400)).toString("base64url");
  const payload = `${flash.kind}.${text}.${now + FLASH_SECONDS * 1000}`;
  const signature = sign(`${actor} ${payload}`, keyFor(secret, "flash"));
  return `${FLASH_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${FLASH_SECONDS}${cookieScope(secure)}`;
}

/** The notice waiting for this person, or null when there is none, it is not theirs, or it ran out. */
export function readFlash(
  cookieHeader: string | undefined,
  secret: string,
  actor: string,
  now = Date.now(),
): Flash | null {
  const parts = parseCookies(cookieHeader)[FLASH_COOKIE]?.split(".");
  if (parts?.length !== 4) return null;
  const [kind, text, expiry, signature] = parts as [string, string, string, string];
  if (kind !== "success" && kind !== "error") return null;
  const expected = sign(`${actor} ${kind}.${text}.${expiry}`, keyFor(secret, "flash"));
  if (!constantTimeEqual(expected, signature)) return null;
  if (!(Number(expiry) >= now)) return null;
  return { kind, message: Buffer.from(text, "base64url").toString() };
}

export function hasFlash(cookieHeader: string | undefined): boolean {
  return FLASH_COOKIE in parseCookies(cookieHeader);
}

export function clearFlash(secure = false): string {
  return `${FLASH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieScope(secure)}`;
}

/** Whether two strings match, taking as long whether or not they do. */
export function sameText(a: string, b: string): boolean {
  return constantTimeEqual(sign(a, "compare"), sign(b, "compare"));
}

export function clearSessionCookie(secure = false): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieScope(secure)}`;
}

export function clearPreviewCookie(secure = false, domain?: string): string {
  return `${PREVIEW_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieScope(secure, domain)}`;
}

function cookieScope(secure: boolean, domain?: string): string {
  return `${secure ? "; Secure" : ""}${domain ? `; Domain=${domain}` : ""}`;
}

/**
 * Sessions are signed with the password mixed into the secret, so changing the
 * password signs every existing session out: which is the whole point of
 * changing it after one leaks.
 */
export function sessionKey(secret: string, password: string): string {
  return createHmac("sha256", secret).update(`session ${password}`).digest("hex");
}

export function readSession(cookieHeader: string | undefined, secret: string): Session | null {
  return readSigned(parseCookies(cookieHeader)[COOKIE], keyFor(secret, "session"));
}

export function readPreviewSession(
  cookieHeader: string | undefined,
  secret: string,
): Session | null {
  return readSigned(parseCookies(cookieHeader)[PREVIEW_COOKIE], keyFor(secret, "preview"));
}

function readSigned(raw: string | undefined, key: string): Session | null {
  const parts = decoded(raw)?.split(".");
  if (parts?.length !== 4) return null;
  const [actor, stamp, expiry, signature] = parts as [string, string, string, string];
  if (!/^(studio|editor:\d+|github:\d+)$/.test(actor)) return null;
  if (!constantTimeEqual(sign(`${actor}.${stamp}.${expiry}`, key), signature)) return null;
  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return { actor, stamp, expiresAt, id: signature };
}

/** One key per kind of token, so none of them can be passed off as another. */
function keyFor(
  secret: string,
  purpose: "session" | "preview" | "share" | "stamp" | "github" | "flash",
): string {
  return createHmac("sha256", secret).update(`greatcms ${purpose}`).digest("hex");
}

/** A cookie value, or undefined when it is missing or not valid percent-encoding. */
function decoded(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function checkPassword(supplied: string, expected: string): boolean {
  return constantTimeEqual(sign(supplied, "password-check"), sign(expected, "password-check"));
}

/** `scrypt$<salt>$<hash>`: Node's own KDF, so no dependency stands between a password and its hash. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  return constantTimeEqual(scryptSync(password, salt, 32).toString("base64url"), hash);
}

export function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Cross-site request forgery defence for a cookie-authenticated app with no
 * JavaScript. `SameSite=Lax` already stops a browser attaching the session to a
 * cross-site POST; this refuses the request as well, and falls back to Referer
 * for the rare client that sends one but no Origin. A request with neither is
 * allowed through, because that is curl, not a browser being steered.
 */
export function isSameOrigin(request: Request): boolean {
  // The browser's own account of where the request came from, which a page cannot set or strip.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const host = new URL(request.url).host;
  const origin = request.headers.get("origin");
  if (origin) return hostOf(origin) === host;

  const referer = request.headers.get("referer");
  if (referer) return hostOf(referer) === host;

  return true;
}

/** null for anything unparseable, so an opaque origin never matches a real host. */
function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}
