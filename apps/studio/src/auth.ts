/** Authentication for a single-operator, self-hosted studio: one password, one signed cookie. */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "greatcms_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

export interface Session {
  actor: string;
  expiresAt: number;
}

export function createSessionCookie(secret: string, actor = "studio"): string {
  const expiresAt = Date.now() + MAX_AGE_SECONDS * 1000;
  const payload = `${actor}.${expiresAt}`;
  const value = `${payload}.${sign(payload, secret)}`;
  // Lax rather than Strict: every state change is a same-origin POST, checked separately.
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readSession(cookieHeader: string | undefined, secret: string): Session | null {
  const raw = parseCookies(cookieHeader)[COOKIE];
  if (!raw) return null;

  const parts = decodeURIComponent(raw).split(".");
  if (parts.length !== 3) return null;
  const [actor, expiry, signature] = parts as [string, string, string];

  if (!constantTimeEqual(sign(`${actor}.${expiry}`, secret), signature)) return null;

  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

  return { actor, expiresAt };
}

export function checkPassword(supplied: string, expected: string): boolean {
  return constantTimeEqual(sign(supplied, "password-check"), sign(expected, "password-check"));
}

export function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Cross-site request forgery defence for a cookie-authenticated app with no JavaScript: every state change. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // curl and no-JS clients that omit it entirely
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
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
