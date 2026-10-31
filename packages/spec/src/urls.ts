/** Which addresses content may hold: a page must never be able to carry script in a link. */

const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * A relative URL, a fragment, or one whose scheme cannot run code. Browsers ignore control
 * characters and whitespace inside a scheme, so `java\tscript:` is read as `javascript:`.
 */
export function isSafeUrl(value: string): boolean {
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  const compact = value.replace(/[\u0000- \u007f]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1];
  return scheme === undefined || SAFE_SCHEMES.has(scheme.toLowerCase());
}
