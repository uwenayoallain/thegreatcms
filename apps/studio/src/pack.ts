/** Compressing pages as they leave: Brotli where the browser takes it, off the main thread. */

import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { MiddlewareHandler } from "hono";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/i;
/** Below this the headers cost more than the bytes saved. */
const THRESHOLD = 1024;

/** The best encoding a browser's `Accept-Encoding` allows, or null for neither. */
export function preferredEncoding(accept: string | undefined): "br" | "gzip" | null {
  const accepted = new Map(
    (accept ?? "").split(",").map((part) => {
      const [name = "", ...params] = part.trim().toLowerCase().split(";");
      const q = params.find((param) => param.trim().startsWith("q="));
      return [name.trim(), q ? Number(q.trim().slice(2)) : 1] as const;
    }),
  );
  const wants = (encoding: string) => (accepted.get(encoding) ?? accepted.get("*") ?? 0) > 0;
  return wants("br") ? "br" : wants("gzip") ? "gzip" : null;
}

/**
 * Pages are rendered whole, so they are compressed whole: Brotli at a level that costs less than
 * gzip's default and comes out smaller. Anything already encoded, such as the bundles, is left.
 */
export const pack: MiddlewareHandler = async (c, next) => {
  await next();
  const response = c.res;
  if (
    !response.body ||
    c.req.method === "HEAD" ||
    response.headers.has("content-encoding") ||
    !COMPRESSIBLE.test(response.headers.get("content-type") ?? "")
  ) {
    return;
  }
  const vary = response.headers.get("vary");
  if (!vary || !/accept-encoding/i.test(vary)) {
    response.headers.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  }
  const encoding = preferredEncoding(c.req.header("accept-encoding"));
  if (!encoding) return;
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length < THRESHOLD) {
    c.res = new Response(raw, response);
    return;
  }
  const packed =
    encoding === "br"
      ? await brotli(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 4,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        })
      : await gzipped(raw, { level: 6 });
  const headers = new Headers(response.headers);
  headers.set("content-encoding", encoding);
  headers.set("content-length", String(packed.length));
  const etag = headers.get("etag");
  if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
  c.res = new Response(new Uint8Array(packed), { status: response.status, headers });
};
